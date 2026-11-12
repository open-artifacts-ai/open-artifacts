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
import { toUserRef } from "../src/services/users.js";
import { login } from "./helpers.js";

// #1894: broader phrasings that read as an agent.
const CAUGHT = [
  "Leos agent",
  "Leo Urbina, agent",
  "Leo Urbina (agent)",
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
const ALLOWED = [
  "Agent Smith",
  "Agnes",
  "Botha",
  "Abbot",
  "Ai Weiwei",
  "Claude Monet",
  "Bob Assistant-Manager",
  "Aiden",
  "Leo Urbina",
];

describe("readsAsAgent phrasings", () => {
  it.each(CAUGHT)("catches %s", (n) => {
    expect(readsAsAgent(n)).toBe(true);
    expect(publicName({ name: n })).toBeNull();
    expect(
      toUserRef({ id: "u", email: "l@x.com", name: "x", displayName: n }, true)
        .name,
    ).toBe("l@x.com");
    expect(
      toUserRef({ id: "u", email: "l@x.com", name: "x", displayName: n }, false)
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
