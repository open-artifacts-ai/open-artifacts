/// <reference types="node" />
// Task I1: "an agent's day" — the cross-track end-to-end journey, against the
// real server (wrangler dev; see fixtures.ts). Eight steps, serial:
// 1. OAuth connect + publish a 3-file poll with db+viewer capabilities.
// 2. The owner's library lists it with the agent's client name.
// 3. Owner and member vote; each sees the other's vote live (≤ 2 s).
// 4. v2 with a changed label; the diff shows it; the votes survive.
// 5. Public + allowAnonymousWrites; the 31st anonymous write is rejected.
// 6. A 5 MB PDF via create_upload; the owner views it; search finds a
//    page-2 phrase (the extracted text came from the browser).
// 7. Delete → the agent gets not_found; Undo restores it.
// 8. A PAT agent reads the votes with artifact_data_query.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Response } from "@playwright/test";
import {
  APP,
  artifactFrame,
  createToken,
  expect,
  loginAs,
  test,
  uniq,
} from "./fixtures";
import { type Agent, mcpWithToken, oauthSession } from "./mcp-client";

const OWNER = `journey-owner-${uniq()}@e2e.test`;
const MEMBER = `journey-member-${uniq()}@e2e.test`;
const AGENT_NAME = "Journey Agent";
const V2_LABEL = "Tabs or spaces? — the final call";
const MARKER = "zephyr-quartz-pagetest-76";

let agent: Agent;
let pollId = "";
let title = "";

/** The three poll files; `label` overrides the v1 heading for v2 publishes. */
function pollFiles(label = "Tabs or spaces?") {
  const dir = fileURLToPath(new URL("./fixtures/poll/", import.meta.url));
  const index = readFileSync(`${dir}index.html`, "utf8").replace(
    /<h1 id="label">.*<\/h1>/,
    `<h1 id="label">${label}</h1>`,
  );
  return {
    "index.html": index,
    "app.js": readFileSync(`${dir}app.js`, "utf8"),
    "styles.css": readFileSync(`${dir}styles.css`, "utf8"),
  };
}

/** A valid ~5 MB two-page PDF whose page 2 carries MARKER, built by hand. */
function bigPdf(): Uint8Array {
  const esc = (s: string) =>
    s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const text = (lines: string[]) =>
    `BT\n/F1 11 Tf\n72 740 Td\n14 TL\n${lines
      .map((l) => `(${esc(l)}) Tj T*`)
      .join("\n")}\nET\n`;
  const padding: string[] = [];
  for (let i = 0; i < 125000; i++)
    padding.push(`filler line ${i} of the journey pdf`);
  const page1 = text([
    "Journey PDF page one",
    "This file was uploaded through create_upload and PUT.",
  ]);
  const page2 = text([`The secret phrase is ${MARKER}.`, ...padding]);
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> /Contents 7 0 R >>",
    `<< /Length ${page1.length} >>\nstream\n${page1}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${page2.length} >>\nstream\n${page2}endstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 0; i < objs.length; i++) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets
    .map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)
    .join(
      "",
    )}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

test.describe.configure({ mode: "serial" });
// Step 1 needs the OAuth provider's `__Host-…; Secure` consent-transaction
// cookie, which WebKit refuses to send over the plain-http dev origin (Chromium
// treats localhost as trustworthy; WebKit does not). Every step depends on it.
test.skip(
  ({ browserName }) => browserName === "webkit",
  "WebKit drops the provider's Secure consent cookie over http; chromium covers the journey",
);

test("1. the agent connects through OAuth and publishes the poll", async ({
  page,
}) => {
  const session = await oauthSession(page, OWNER, AGENT_NAME);
  agent = await mcpWithToken(session.token, AGENT_NAME);
  title = `Journey Poll ${uniq()}`;
  const r = await agent.call("publish_artifact", {
    title,
    files: pollFiles(),
    entry: "index.html",
    capabilities: { db: true, viewer: true },
  });
  expect(r.ok, r.text).toBe(true);
  pollId = (r.data as { id: string }).id;
});

test("2. the owner's library lists the poll with the agent's name", async ({
  browser,
}) => {
  const ctx = await browser.newContext({ baseURL: APP });
  const owner = await ctx.newPage();
  await loginAs(owner, OWNER, "member");
  await owner.goto("/");
  await expect(
    owner.getByRole("link", { name: title, exact: true }),
  ).toBeVisible();
  // The artifact's card/row (not the agent-filter dropdown's hidden <option>)
  // shows the registered client name as lastAgent.
  const row = owner.locator("article").filter({ hasText: title });
  await expect(row.getByText(AGENT_NAME)).toBeVisible();
  await ctx.close();
});

test("3. owner and member vote; each sees the other's vote live", async ({
  browser,
}) => {
  // The member gets access: the agent (acting for the owner) shares the poll.
  const share = await agent.call("share_artifact", {
    id: pollId,
    email: MEMBER,
    role: "viewer",
  });
  expect(share.ok, share.text).toBe(true);

  const ownerCtx = await browser.newContext({ baseURL: APP });
  const owner = await ownerCtx.newPage();
  await loginAs(owner, OWNER, "member");
  await owner.goto(`/a/${pollId}`);
  const memberCtx = await browser.newContext({ baseURL: APP });
  const member = await memberCtx.newPage();
  await loginAs(member, MEMBER, "member");
  await member.goto(`/a/${pollId}`);

  const f1 = artifactFrame(owner);
  const f2 = artifactFrame(member);
  // Live delivery must be armed before the first vote: the poll re-renders only
  // on push events (its initial list() predates the vote), so a vote cast
  // before the subscription lands would never be delivered.
  await expect(f1.locator("html")).toHaveAttribute("data-oa-subscribed", "");
  await expect(f2.locator("html")).toHaveAttribute("data-oa-subscribed", "");
  await f1.getByRole("button", { name: "Tabs", exact: true }).click();
  await f2.getByRole("button", { name: "Spaces", exact: true }).click();

  // The vote id is the sanitized email local part ([A-Za-z0-9_-] only).
  const ownerLocal = OWNER.split("@")[0];
  const memberLocal = MEMBER.split("@")[0];

  // Live within 2 s, without reloading either page.
  await expect(f1.getByText(memberLocal)).toBeVisible({ timeout: 2000 });
  await expect(f2.getByText(ownerLocal)).toBeVisible({ timeout: 2000 });
  await ownerCtx.close();
  await memberCtx.close();
});

test("4. v2 with a changed label: the diff shows it, the votes survive", async ({
  browser,
}) => {
  const r = await agent.call("publish_artifact", {
    id: pollId,
    files: pollFiles(V2_LABEL),
    entry: "index.html",
    message: "v2",
  });
  expect(r.ok, r.text).toBe(true);

  const ctx = await browser.newContext({ baseURL: APP });
  const owner = await ctx.newPage();
  await loginAs(owner, OWNER, "member");
  await owner.goto(`/a/${pollId}/diff/1/2`);
  // The diff view shows the changed label line.
  await expect(owner.locator("main").getByText(V2_LABEL).first()).toBeVisible();
  await ctx.close();

  // The votes survived the version bump.
  const q = await agent.call("artifact_data_query", {
    id: pollId,
    collection: "votes",
    query: {},
  });
  expect(q.ok, q.text).toBe(true);
  const items = (q.data as { items: unknown[] }).items ?? [];
  expect(items.length).toBeGreaterThanOrEqual(2);
});

test("5. public with anonymous writes; the anon write limit is enforced", async ({
  browser,
}) => {
  const ctx = await browser.newContext({ baseURL: APP });
  const owner = await ctx.newPage();
  await loginAs(owner, OWNER, "member");
  await owner.goto(`/a/${pollId}`);
  await owner.getByRole("button", { name: "Share" }).click();
  await owner
    .getByLabel("Visibility")
    .getByRole("radio", { name: "Public" })
    .check();
  await owner.getByRole("button", { name: "Save visibility" }).click();
  await owner.getByRole("button", { name: "Make public" }).click();
  // The checkbox unlocks only once the artifact state refetches as public.
  // Anyone who can view may write by default (#681), so making it public
  // already lets anonymous visitors write; clicking would turn that off.
  const anonBox = owner.getByLabel("Allow anonymous writes");
  await expect(anonBox).toBeEnabled();
  await expect(anonBox).toBeChecked();
  await ctx.close();

  const anonCtx = await browser.newContext({ baseURL: APP });
  const anon = await anonCtx.newPage();
  await anon.goto(`/a/${pollId}`);
  const f = artifactFrame(anon);
  // The app arms its vote listeners after `ready` and its subscription; a click
  // before that is lost (the button is static HTML). Same signal as step 3.
  await expect(f.locator("html")).toHaveAttribute("data-oa-subscribed", "");
  const vote = f.getByRole("button", { name: "Tabs", exact: true });
  const err = f.locator("#err");
  await vote.click();
  // On a fresh server (every CI run) writes 1..30 pass and the 31st in the
  // minute is rejected. Repeated runs inside one minute share the client IP and
  // its 30/min budget, so the first click can already be limited; then the
  // boundary is unobservable but the limit still has to be visible. Both paths
  // are deterministic, which is what keeps this from flaking in CI.
  await expect
    .poll(
      async () =>
        `${await f.locator("#status").textContent()}${await err.textContent()}`,
      { timeout: 10_000 },
    )
    .toMatch(/voted tabs|rate.?limit|too many/i);
  // The limiter's window is minute-aligned, so 31 clicks can straddle a
  // window reset and never hit the limit. Two windows of 30 plus one (61)
  // always do. Every click clears #err, and once a window resets later votes
  // pass again, so the message can be gone by the time it is read (#482).
  // So: the proof is the first 429 on the network, clicking stops there, and
  // a MutationObserver records that the page did show the limit message.
  const LIMIT = /rate.?limit|too many/i;
  const isLimited = (r: Response) =>
    r.status() === 429 &&
    r.request().method() === "PUT" &&
    r.url().includes("/data/votes/");
  let limited = false;
  const first429 = anon
    .waitForResponse(isLimited, { timeout: 60_000 })
    .then((r) => {
      limited = true;
      return r;
    });
  await err.evaluate((el, src) => {
    const re = new RegExp(src, "i");
    const w = window as unknown as { __oaSawLimit?: boolean };
    w.__oaSawLimit = re.test(el.textContent ?? "");
    new MutationObserver(() => {
      if (re.test(el.textContent ?? "")) w.__oaSawLimit = true;
    }).observe(el, { childList: true, characterData: true, subtree: true });
  }, LIMIT.source);
  for (let i = 2; i <= 61 && !limited; i++) await vote.click();
  expect((await first429).status()).toBe(429);
  await expect
    .poll(
      () =>
        err.evaluate(
          () =>
            (window as unknown as { __oaSawLimit?: boolean }).__oaSawLimit ===
            true,
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
  await anonCtx.close();
});

test("6. a 5 MB PDF via create_upload; search finds the page-2 phrase", async ({
  browser,
}) => {
  const pdf = bigPdf();
  expect(pdf.length).toBeGreaterThan(5 * 1024 * 1024 - 64 * 1024);
  const up = await agent.call("create_upload", {
    path: "journey.pdf",
    size: pdf.length,
    contentType: "application/pdf",
  });
  expect(up.ok, up.text).toBe(true);
  const { uploadId, url, artifactId } = up.data as {
    uploadId: string;
    url: string;
    artifactId: string;
  };
  const put = await fetch(url, {
    method: "PUT",
    body: new Uint8Array(pdf),
    headers: { "content-type": "application/pdf" },
  });
  expect(put.status).toBe(204);
  // The upload is bound to its reserved artifact id: publish onto it.
  const pub = await agent.call("publish_artifact", {
    id: artifactId,
    title: `Journey PDF ${uniq()}`,
    files: { "journey.pdf": { uploadId } },
    entry: "journey.pdf",
  });
  expect(pub.ok, pub.text).toBe(true);
  const pdfId = (pub.data as { id: string }).id;

  // The owner views it: the browser extracts the text and PUTs it.
  const ctx = await browser.newContext({ baseURL: APP });
  const owner = await ctx.newPage();
  await loginAs(owner, OWNER, "member");
  const textPut = owner.waitForResponse(
    (r) => r.request().method() === "PUT" && r.url().includes("/text"),
  );
  await owner.goto(`/a/${pdfId}`);
  expect((await textPut).ok()).toBe(true);
  await ctx.close();

  const found = await agent.call("search_artifacts", { q: MARKER });
  expect(found.ok, found.text).toBe(true);
  expect(JSON.stringify(found.data)).toContain(pdfId);
});

test("7. delete: the agent gets not_found; undo restores it", async ({
  browser,
}) => {
  const ctx = await browser.newContext({ baseURL: APP });
  const owner = await ctx.newPage();
  await loginAs(owner, OWNER, "member");
  await owner.goto(`/a/${pollId}`);
  await owner.getByRole("button", { name: "More actions" }).click();
  await owner.getByRole("menuitem", { name: "Delete" }).click();
  await owner
    .getByRole("alertdialog", { name: "Delete artifact?" })
    .getByRole("button", { name: "Delete" })
    .click();

  // The delete is an async request; poll until the agent sees it gone rather
  // than racing the first read.
  await expect
    .poll(async () => (await agent.call("get_artifact", { id: pollId })).ok, {
      timeout: 5_000,
    })
    .toBe(false);
  const gone = await agent.call("get_artifact", { id: pollId });
  expect(gone.ok).toBe(false);
  expect(gone.text).toContain("not_found");

  await owner.getByRole("button", { name: "Undo" }).click();
  // Undo is async as well: wait for the restore to land before asserting.
  await expect
    .poll(async () => (await agent.call("get_artifact", { id: pollId })).ok, {
      timeout: 5_000,
    })
    .toBe(true);
  const back = await agent.call("get_artifact", { id: pollId });
  expect(back.ok, back.text).toBe(true);
  await ctx.close();
});

test("8. a PAT agent reads the votes", async ({ page }) => {
  await loginAs(page, OWNER, "member");
  const pat = await createToken(page);
  const patAgent = await mcpWithToken(pat, "Journey PAT Agent");
  const r = await patAgent.call("artifact_data_query", {
    id: pollId,
    collection: "votes",
    query: {},
  });
  expect(r.ok, r.text).toBe(true);
  const items = (r.data as { items: unknown[] }).items ?? [];
  expect(items.length).toBeGreaterThanOrEqual(2);
  await patAgent.close();
});

// Keep the random import referenced for unique titles per run.
void randomBytes;
