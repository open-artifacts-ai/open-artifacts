import { beforeEach, describe, expect, it } from "vitest";
import { audit, hmac16 } from "../src/audit.js";
import { ADMIN_P, db, fakeEnv, migrate, tokenP } from "./fakes.js";

// 4.9: one admin_audit row per action; no raw IP or email, HMACs only.

beforeEach(() => migrate());

const last = (action: string) =>
  db
    .prepare("SELECT * FROM admin_audit WHERE action = ? ORDER BY id DESC")
    .bind(action)
    .first<Record<string, unknown>>();

describe("audit()", () => {
  it("writes the principal's actor, the HMACs and the detail", async () => {
    const { env } = fakeEnv();
    await audit(env, {
      action: "test.one",
      actor: ADMIN_P,
      outcome: "refused",
      route: "R2",
      code: "forbidden",
      ip: "192.0.2.7",
      email: "who@acme.test",
      detail: { x: 1 },
    });
    const r = await last("test.one");
    expect(r).toMatchObject({
      actor_kind: "admin",
      actor_label: "me@example.com",
      outcome: "refused",
      code: "forbidden",
      ip_hmac: await hmac16(env, "192.0.2.7"),
      email_hmac: await hmac16(env, "who@acme.test"),
    });
    expect(r?.ip_hmac).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(r)).not.toContain("192.0.2.7");
    expect(JSON.stringify(r)).not.toContain("who@acme.test");
    expect(JSON.parse(r?.detail as string)).toEqual({ x: 1, route: "R2" });
  });

  it("a token row carries token_id and the minting admin; mcp adds surface", async () => {
    const { env } = fakeEnv();
    const t = tokenP(["installs:read"]);
    await audit(env, {
      action: "test.two",
      actor: t,
      outcome: "ok",
      surface: { kind: "mcp", tool: "get_world", clientVersion: null },
    });
    const r = await last("test.two");
    expect(r).toMatchObject({ actor_kind: "token", token_id: t.tokenId });
    expect(JSON.parse(r?.detail as string)).toEqual({
      admin: "me@example.com",
      surface: "mcp",
      tool: "get_world",
      clientVersion: null,
    });
  });

  it("sign-in and system actors", async () => {
    const { env } = fakeEnv();
    await audit(env, {
      action: "test.three",
      actor: { kind: "signin", email: "a@b.test", sub: "9" },
      outcome: "refused",
    });
    expect(await last("test.three")).toMatchObject({
      actor_kind: "admin",
      actor_label: "a@b.test",
    });
    await audit(env, {
      action: "test.four",
      actor: "system:scheduler",
      outcome: "ok",
    });
    expect(await last("test.four")).toMatchObject({
      actor_kind: "system",
      actor_label: "scheduler",
    });
  });
});
