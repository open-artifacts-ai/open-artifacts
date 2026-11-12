import { type CommentList, R } from "@oa/shared";
import type { Agent } from "../../real/mcp-client";
import {
  api,
  cleanup,
  expect,
  json,
  needs,
  OAUTH_HOOK_EMAIL,
  oauthAgent,
  personAt,
  publish,
  refusal,
  test,
} from "./fixtures";

// T19: the comments flows of 0.162.0 on rl-a, with the accounts the suite
// has: the OAuth hook's member and its MCP agent. That agent is unlinked (no
// bus identity), so it comments and asks but joins no thread and can't be
// mentioned: the participants pill, held notices and delivery marks need a
// linked bus agent, which rl-a has no fixture for (see the PR body).
// Each test gates on the release (gate.ts) and `cleanup` deletes the pages.

const MIN = "0.162.0";

test.afterAll(cleanup);

const commentable = (title: string) => ({
  title,
  format: "html" as const,
  content: `<!doctype html><title>${title}</title><p>${title}</p>`,
  comments: true,
});

/** The OAuth hook's member signed in, owning one commentable page. */
async function ownerWithPage(
  browser: Parameters<typeof personAt>[0],
  title: string,
) {
  const owner = await personAt(
    browser,
    OAUTH_HOOK_EMAIL,
    "agent-owner",
    "member",
  );
  const { id } = await publish(owner, commentable(`${title} ${Date.now()}`));
  return { owner, id };
}

const threads = async (agent: Agent, id: string) => {
  const r = await agent.call("list_comments", { id });
  expect(r.ok, r.text).toBe(true);
  return (r.data as unknown as CommentList).threads;
};

test("asks: an agent's ask, a person's typed answer (yes), and toAsker replies", async ({
  browser,
}) => {
  await needs("asks and toAsker (#1535, #1794)", MIN);
  const { owner, id } = await ownerWithPage(browser, "T19 ask");
  const agent = await oauthAgent();
  try {
    const question = "Ship the short version?";
    const options = [
      { id: "short", label: "Short" },
      { id: "full", label: "Full" },
    ];
    const asked = await agent.call("add_comment", {
      id,
      body: question,
      ask: { question, options, to: [{ key: owner.id }] },
    });
    expect(asked.ok, asked.text).toBe(true);
    const [thread] = await threads(agent, id);
    const root = thread?.comments[0];
    if (!thread || !root?.ask) throw new Error("the ask is not listed");
    expect(root.ask.answer).toBeUndefined();

    // The person picks in the browser session: typed, and their yes on an ask
    // their own agent posted.
    await json(
      await api(owner, R.commentAnswer(id, thread.id, root.id), {
        method: "POST",
        body: JSON.stringify({ optionId: "short" }),
      }),
    );
    const answered = (await threads(agent, id))[0]?.comments[0]?.ask?.answer;
    expect(answered).toMatchObject({
      optionId: "short",
      typed: true,
      yes: true,
    });

    // toAsker: reaches the asking agent's address, if it has one (this one
    // has none, so nobody is told) and is still a reply.
    const reply = await api(owner, R.commentReplies(id, thread.id), {
      method: "POST",
      body: JSON.stringify({ body: "Yes, short.", toAsker: true }),
    });
    expect(reply.status).toBe(201);
    // Never with mentions.
    const both = await api(owner, R.commentReplies(id, thread.id), {
      method: "POST",
      body: JSON.stringify({
        body: "Also them",
        toAsker: true,
        mentions: [{ key: `agent:${"0".repeat(32)}` }],
      }),
    });
    expect(await refusal(both, 400)).toBe("bad_request");
  } finally {
    await agent.close();
  }
});

test("asks: toAsker on a person's thread is not_an_ask", async ({
  browser,
}) => {
  await needs("toAsker (#1794)", MIN);
  const { owner, id } = await ownerWithPage(browser, "T19 not an ask");
  const t = await json<{ id: string }>(
    await api(owner, R.comments(id), {
      method: "POST",
      body: JSON.stringify({ anchor: { kind: "note" }, body: "A person asks" }),
    }),
  );
  const res = await api(owner, R.commentReplies(id, t.id), {
    method: "POST",
    body: JSON.stringify({ body: "To the asker", toAsker: true }),
  });
  expect(await refusal(res, 400)).toBe("not_an_ask");
});

test("live reply: an agent's reply shows with the page open, no reload", async ({
  browser,
}) => {
  await needs("live replies (#2179)", MIN);
  const { owner, id } = await ownerWithPage(browser, "T19 live reply");
  const t = await json<{ id: string }>(
    await api(owner, R.comments(id), {
      method: "POST",
      body: JSON.stringify({ anchor: { kind: "note" }, body: "Watching" }),
    }),
  );
  const agent = await oauthAgent();
  try {
    const page = owner.page;
    await page.goto(`/a/${id}`);
    await page.getByRole("button", { name: /^Comments/ }).click();
    await expect(
      page.getByRole("textbox", { name: "Comment on the whole page" }),
    ).toBeVisible();
    const body = "Arrived while you were reading";
    const posted = await agent.call("add_comment", {
      id,
      threadId: t.id,
      body,
    });
    expect(posted.ok, posted.text).toBe(true);
    await expect(
      page.locator("[data-comment]").filter({ hasText: body }),
    ).toBeVisible();
  } finally {
    await agent.close();
  }
});

for (const [w, h] of [
  [1280, 800],
  [390, 844],
] as const)
  test(`composer at ${w}px: the field grows to its cap and sends`, async ({
    browser,
  }) => {
    await needs("composer (#2118)", MIN);
    const { owner, id } = await ownerWithPage(browser, `T19 composer ${w}`);
    const page = owner.page;
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`/a/${id}`);
    await page.getByRole("button", { name: /^Comments/ }).click();
    const note = page.getByRole("textbox", {
      name: "Comment on the whole page",
    });
    await expect(note).toBeVisible();
    await note.fill("One line");
    const one = (await note.boundingBox())?.height ?? 0;
    await note.fill(
      Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n"),
    );
    const grown = (await note.boundingBox())?.height ?? 0;
    expect(grown).toBeGreaterThan(one);
    // The cap is 240px (comments-column-shots.spec.ts), plus a border pixel.
    expect(grown).toBeLessThanOrEqual(241);
    const text = `Sent at ${w}`;
    await note.fill(text);
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(
      page.locator("[data-comment]").filter({ hasText: text }),
    ).toBeVisible();
    await expect(note).toHaveValue("");
  });
