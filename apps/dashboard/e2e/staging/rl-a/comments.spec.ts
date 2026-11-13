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
  type Person,
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

const STEP_MS = 15_000;
// Setup calls pace themselves against the hook window (hook-pace.ts), bounded
// by the hook's own timeout less a margin; this only names a hang just under it.
const SETUP_MS = 55_000;

/** Fails fast and by name: a hung network step says which one hung. */
async function step<T>(
  name: string,
  fn: () => Promise<T>,
  ms = STEP_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${name} timed out after ${ms / 1000}s`)),
      ms,
    );
  });
  try {
    return await Promise.race([fn(), late]);
  } finally {
    clearTimeout(timer);
  }
}

// Two hook calls in all: one session, one OAuth grant (budget: 10 or fewer).
let owner: Person;
let agent: Agent;
test.beforeAll(async ({ browser }) => {
  owner = await step(
    "setup personAt",
    () => personAt(browser, OAUTH_HOOK_EMAIL, "agent-owner", "member"),
    SETUP_MS,
  );
  agent = await step("setup oauthAgent", () => oauthAgent(), SETUP_MS);
});
test.afterAll(async () => {
  await agent?.close();
  await cleanup();
});

const commentable = (title: string) => ({
  title,
  format: "html" as const,
  content: `<!doctype html><title>${title}</title><p>${title}</p>`,
  comments: true,
});

/** One commentable page owned by the shared person. */
async function pageOf(title: string) {
  const { id } = await step("publish page", () =>
    publish(owner, commentable(`${title} ${Date.now()}`)),
  );
  return id;
}

const threads = async (agent: Agent, id: string) => {
  const r = await step("agent list_comments", () =>
    agent.call("list_comments", { id }),
  );
  expect(r.ok, r.text).toBe(true);
  return (r.data as unknown as CommentList).threads;
};

test("asks: an agent's ask, a person's answer (not a yes), and toAsker replies", async () => {
  await needs("asks and toAsker (#1535, #1794)", MIN);
  const id = await pageOf("T19 ask");
  {
    const question = "Ship the short version?";
    const options = [
      { id: "short", label: "Short" },
      { id: "full", label: "Full" },
    ];
    const asked = await step("agent add_comment (ask)", () =>
      agent.call("add_comment", {
        id,
        body: question,
        ask: { question, options, to: [{ key: owner.id }] },
      }),
    );
    expect(asked.ok, asked.text).toBe(true);
    const [thread] = await threads(agent, id);
    const root = thread?.comments[0];
    if (!thread || !root?.ask) throw new Error("the ask is not listed");
    expect(root.ask.answer).toBeUndefined();

    // The person picks in their session. T19 sessions use provider "test",
    // which never counts as typed (auth/authz.ts interactiveSession), so the
    // pick is recorded but is not a yes, by design.
    await json(
      await step("POST commentAnswer", () =>
        api(owner, R.commentAnswer(id, thread.id, root.id), {
          method: "POST",
          body: JSON.stringify({ optionId: "short" }),
        }),
      ),
    );
    const answered = (await threads(agent, id))[0]?.comments[0]?.ask?.answer;
    expect(answered).toMatchObject({
      optionId: "short",
      typed: false,
      yes: false,
    });

    // toAsker: reaches the asking agent's address, if it has one (this one
    // has none, so nobody is told) and is still a reply.
    const reply = await step("POST commentReplies (toAsker)", () =>
      api(owner, R.commentReplies(id, thread.id), {
        method: "POST",
        body: JSON.stringify({ body: "Yes, short.", toAsker: true }),
      }),
    );
    expect(reply.status).toBe(201);
    // Never with mentions.
    const both = await step("POST commentReplies (toAsker + mentions)", () =>
      api(owner, R.commentReplies(id, thread.id), {
        method: "POST",
        body: JSON.stringify({
          body: "Also them",
          toAsker: true,
          mentions: [{ key: `agent:${"0".repeat(32)}` }],
        }),
      }),
    );
    expect(await refusal(both, 400)).toBe("bad_request");
  }
  // A person's thread has no agent to reply to.
  const t = await json<{ id: string }>(
    await step("POST comments (person's thread)", () =>
      api(owner, R.comments(id), {
        method: "POST",
        body: JSON.stringify({
          anchor: { kind: "note" },
          body: "A person asks",
        }),
      }),
    ),
  );
  const res = await step("POST commentReplies (no asker)", () =>
    api(owner, R.commentReplies(id, t.id), {
      method: "POST",
      body: JSON.stringify({ body: "To the asker", toAsker: true }),
    }),
  );
  expect(await refusal(res, 400)).toBe("not_an_ask");
});

test("live reply: an agent's reply shows with the page open, no reload", async () => {
  await needs("live replies (#2179)", MIN);
  const id = await pageOf("T19 live reply");
  const t = await json<{ id: string }>(
    await step("POST comments (watching)", () =>
      api(owner, R.comments(id), {
        method: "POST",
        body: JSON.stringify({ anchor: { kind: "note" }, body: "Watching" }),
      }),
    ),
  );
  {
    const page = owner.page;
    await page.goto(`/a/${id}`);
    await page.getByRole("button", { name: /^Comments/ }).click();
    await expect(
      page.getByRole("textbox", { name: "Comment on the whole page" }),
    ).toBeVisible();
    const body = "Arrived while you were reading";
    const posted = await step("agent add_comment (reply)", () =>
      agent.call("add_comment", { id, threadId: t.id, body }),
    );
    expect(posted.ok, posted.text).toBe(true);
    await expect(
      page.locator("[data-comment]").filter({ hasText: body }),
    ).toBeVisible();
  }
});

test("composer: the field grows to its cap and sends, at 1280 and 390", async () => {
  await needs("composer (#2118)", MIN);
  const id = await pageOf("T19 composer");
  const page = owner.page;
  for (const [w, h] of [
    [1280, 800],
    [390, 844],
  ] as const) {
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
  }
});
