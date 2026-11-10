import { env } from "cloudflare:workers";
import { MeSchema, newId, R } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { senderName } from "../src/email/templates.js";
import { agentFor } from "../src/services/agent-display.js";
import { shownLastAgent } from "../src/services/artifacts.js";
import { toMember, toUserRef } from "../src/services/users.js";
import { api, login } from "./helpers.js";

// #1894: a name that reads as an agent stays off every surface.
const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
const PUB = { id: "pub1", name: "Leo Urbina", email: "leo@x.com" };
const grant = (name: string, viewer: string | null) =>
  agentFor({ name, version: null }, "g:abc", PUB, viewer).name;

describe("person names that read as an agent (#1894)", () => {
  const row = (displayName: string | null, name = "Leo") => ({
    id: "u1",
    email: "leo@x.com",
    name,
    displayName,
  });
  it("toUserRef: signed in falls back to the email, anonymous to null", () => {
    for (const n of ["Leo Urbina's agent", "Leo’s AGENT.", "Leo​'s agent"]) {
      expect(toUserRef(row(n), true).name).toBe("leo@x.com");
      expect(toUserRef(row(n), false).name).toBeNull();
      expect(toUserRef(row(null, n), true).name).toBe("leo@x.com");
    }
    expect(toUserRef(row("Leo Urbina"), true).name).toBe("Leo Urbina");
    expect(toUserRef(row("Agent Smith"), false).name).toBe("Agent Smith");
  });
  it("toMember falls back to the email", () => {
    const m = (displayName: string | null) =>
      toMember({
        ...row(displayName),
        role: "member",
        lastSeenAt: null,
      } as never);
    expect(m("Leo Urbina's agent").name).toBe("leo@x.com");
    expect(m("Leo Urbina").name).toBe("Leo Urbina");
  });
  it("senderName falls back to the email", () => {
    expect(senderName({ name: "Leo's agent", email: "leo@x.com" })).toBe(
      "leo@x.com",
    );
    expect(senderName({ name: "Leo U", email: "leo@x.com" })).toBe("Leo U");
  });
  it("the user still sees their own name on /me", async () => {
    const l = await login(`own-${tag}@x.com`, "member");
    await env.DB.prepare("update users set display_name = ? where id = ?")
      .bind("Own Name's agent", l.userId)
      .run();
    const r = await api(app, R.me, l.cookie);
    expect(MeSchema.parse(await r.json()).user.name).toBe("Own Name's agent");
  });
});

describe("unlinked grants in lastAgent and version history (#1894)", () => {
  it("a known product shows in canonical casing, anything else is the person's agent", () => {
    for (const v of [null, "someone"]) {
      expect(grant("Claude Code", v)).toBe("Claude Code");
      expect(grant("claude code", v)).toBe("Claude Code");
      expect(grant("OA Product", v)).toBe("Leo Urbina's agent");
      expect(grant("Claude Code Pro", v)).toBe("Leo Urbina's agent");
      // lookalike (Cyrillic a) and zero-width
      expect(grant("Clаude Code", v)).toBe("Leo Urbina's agent");
      expect(grant("Claude​Code", v)).toBe("Leo Urbina's agent");
    }
  });
  it("the grant's owner sees the raw client name in their own views", () => {
    expect(grant("OA Product", PUB.id)).toBe("OA Product");
  });
  it("a token label stays private, scrubbed rows stay masked", () => {
    const a = { name: "My label", version: null };
    expect(agentFor(a, "t:1", PUB, PUB.id).name).toBe("My label");
    expect(agentFor(a, "t:1", PUB, null).name).toBe("Leo Urbina's agent");
    expect(agentFor(a, "r:", PUB, null).masked).toBe(true);
  });
  it("an owner whose name reads as an agent gets the member stand-in", () => {
    const p = { ...PUB, name: "Leo Urbina's agent" };
    expect(
      agentFor({ name: "OA Product", version: null }, "g:1", p, null).name,
    ).toBe("A member's agent");
  });
  it("shownLastAgent applies the same rule for a guest", () => {
    const pub = JSON.stringify([
      "g:abc",
      "u1",
      "leo@x.com",
      "Leo Urbina",
      null,
      "OA Product",
      null,
    ]);
    expect(shownLastAgent(pub, { kind: "anonymous" })?.name).toBe(
      "Leo Urbina's agent",
    );
  });
});
