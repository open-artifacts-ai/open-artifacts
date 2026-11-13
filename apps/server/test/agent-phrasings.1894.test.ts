import { env } from "cloudflare:workers";
import { newId } from "@oa/shared";
import { describe, expect, it } from "vitest";
import {
  publicName,
  readsAsAgent,
  skeleton,
} from "../src/services/agent-display.js";
import { cleanGuestName } from "../src/services/comment-rules.js";
import {
  allClashes,
  resetNameClashCache,
  usersById,
} from "../src/services/comments.js";
import { shownEffectiveName, toUserRef } from "../src/services/users.js";
import { login } from "./helpers.js";

// #1894: broader phrasings that read as an agent.
const CAUGHT = [
  "Leos agent",
  "Leo Urbina, agent",
  "Leo Urbina (agent)",
  "Leo Urbina (AI)",
  "Leo's AI agent",
  "Leo's Claude Code",
  "Leo's coding agent",
  "Leo's agents",
  "Leo [AI]",
  "Leo: agent",
  "Leo / agent",
  "Leo | agent",
  "Leo Urbina - agent",
  "Leo Urbina's AI",
  "Leo Urbina’s bot",
  "Leo Urbina's assistant",
  "Agent of Leo",
  "Assistant to Leo",
  "Leo Urbina's agent 2",
  "Leo's Claude",
  "Leo​'s agent",
  "LEO URBINA’S AGENT.",
];
// Deliberate trade-offs, reviewed on #2274: real surnames that are caught (they
// show as "Member" to others; the user can rename). Do not change silently.
const TRADE_OFFS = [
  "Chris Agent",
  "Lois Assistant",
  "James Agent",
  "Jan, Bot",
  "Pieter - Bot",
];
const ALLOWED = [
  "Agent Smith",
  "Agnes",
  "Botha",
  "Abbot",
  "Ai Weiwei",
  "Claude Monet",
  "Bob Assistant-Manager",
  "Aiden",
  "Wei, Ai",
  "Li - Ai",
  "Leo Urbina",
];

describe("readsAsAgent phrasings", () => {
  it.each(TRADE_OFFS)("deliberately catches %s", (n) => {
    expect(readsAsAgent(n)).toBe(true);
  });
  it("a real SSO name shows when the display name reads as an agent", () => {
    const u = {
      id: "u",
      email: "l@x.com",
      name: "Leo Urbina",
      displayName: "Leo (AI)",
    };
    expect(shownEffectiveName(u)).toBe("Leo Urbina");
    expect(toUserRef(u, true).name).toBe("Leo Urbina");
    expect(shownEffectiveName({ ...u, name: "Leo's agent" })).toBe("l@x.com");
  });
  it.each(CAUGHT)("catches %s", (n) => {
    expect(readsAsAgent(n)).toBe(true);
    expect(publicName({ name: n })).toBeNull();
    expect(
      toUserRef({ id: "u", email: "l@x.com", name: "l", displayName: n }, true)
        .name,
    ).toBe("l@x.com");
    expect(
      toUserRef({ id: "u", email: "l@x.com", name: "l", displayName: n }, false)
        .name,
    ).toBeNull();
    expect(cleanGuestName(n)).toBe("Guest");
  });
  it.each(ALLOWED)("allows %s", (n) => {
    expect(readsAsAgent(n)).toBe(false);
    expect(publicName({ name: n })).toBe(n);
    expect(cleanGuestName(n)).toBe(n);
  });
});

describe("comments.ts name lists use the same check", () => {
  it("usersById and allClashes drop an agent-reading name", async () => {
    const tag = newId().slice(0, 6).toLowerCase();
    const bad = await login(`ph-a-${tag}@x.com`, "member");
    const good = await login(`ph-b-${tag}@x.com`, "member");
    const phrase = `Phrase ${tag} (agent)`;
    await env.DB.prepare("update users set display_name = ? where id = ?")
      .bind(phrase, bad.userId)
      .run();
    await env.DB.prepare("update users set display_name = ? where id = ?")
      .bind(`Phrase ${tag}`, good.userId)
      .run();
    const users = await usersById(env, [bad.userId, good.userId]);
    expect(users.get(bad.userId)?.name).toBe(`ph-a-${tag}@x.com`);
    expect(users.get(good.userId)?.name).toBe(`Phrase ${tag}`);
    resetNameClashCache();
    const c = await allClashes(env);
    expect(c.get(skeleton(phrase))).toBeUndefined();
    expect([...(c.get(skeleton(`Phrase ${tag}`)) ?? [])]).toEqual([
      good.userId,
    ]);
  });
});
