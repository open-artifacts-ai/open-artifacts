/// <reference types="node" />
// Task I1: "an agent's day", trimmed (#2711) to the two steps only the real
// server proves, serial:
// 1. OAuth connect + publish a 3-file poll with db+viewer capabilities.
// 3. Owner and member vote; each sees the other's vote live (≤ 2 s).
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { APP, artifactFrame, expect, loginAs, test, uniq } from "./fixtures";
import { type Agent, mcpWithToken, oauthSession } from "./mcp-client";

const OWNER = `journey-owner-${uniq()}@e2e.test`;
const MEMBER = `journey-member-${uniq()}@e2e.test`;
const AGENT_NAME = "Journey Agent";
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

// Keep the random import referenced for unique titles per run.
void randomBytes;
