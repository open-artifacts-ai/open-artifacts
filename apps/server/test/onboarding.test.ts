// R.onboarding: the first-run checklist's install-wide state. Owner only.
import { env } from "cloudflare:workers";
import { newId, OnboardingSchema, R } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { api, login } from "./helpers.js";

const app = createApp();
const tag = () => newId().slice(0, 6).toLowerCase();
const clear = () =>
  env.DB.prepare("delete from settings where key like 'onboarding:%'").run();
const get = async (cookie: string) => {
  const r = await api(app, R.onboarding, cookie);
  return {
    status: r.status,
    body: r.ok ? OnboardingSchema.parse(await r.json()) : null,
  };
};
const put = (cookie: string | null, body: unknown) =>
  api(app, R.onboarding, cookie, { method: "PUT", body });

describe("R.onboarding", () => {
  it("starts empty, and the owner's dismissal persists", async () => {
    await clear();
    const o = await login(`own-${tag()}@example.com`, "owner");
    expect((await get(o.cookie)).body).toEqual({
      dismissed: false,
      completed: false,
      hasArtifacts: false,
    });
    const r = await put(o.cookie, { dismissed: true });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      dismissed: true,
      completed: false,
      hasArtifacts: false,
    });
    // Another session of the same owner (another browser) reads it.
    const again = await login(`own2-${tag()}@example.com`, "owner");
    expect((await get(again.cookie)).body?.dismissed).toBe(true);
  });

  it("records completion once and keeps it", async () => {
    await clear();
    const o = await login(`own-${tag()}@example.com`, "owner");
    expect(await (await put(o.cookie, { completed: true })).json()).toEqual({
      dismissed: false,
      completed: true,
      hasArtifacts: false,
    });
    const first = await env.DB.prepare(
      "select value from settings where key = 'onboarding:completed'",
    ).first<{ value: string }>();
    await put(o.cookie, { completed: true });
    const second = await env.DB.prepare(
      "select value from settings where key = 'onboarding:completed'",
    ).first<{ value: string }>();
    expect(second?.value).toBe(first?.value);
  });

  it("refuses everyone but the owner, and writes nothing", async () => {
    await clear();
    for (const role of ["admin", "member", "guest"] as const) {
      const u = await login(`${role}-${tag()}@example.com`, role);
      expect((await put(u.cookie, { dismissed: true })).status).toBe(404);
      expect((await get(u.cookie)).status).toBe(404);
    }
    expect((await put(null, { dismissed: true })).status).toBe(401);
    const o = await login(`own-${tag()}@example.com`, "owner");
    expect((await get(o.cookie)).body).toEqual({
      dismissed: false,
      completed: false,
      hasArtifacts: false,
    });
  });

  it("says whether the caller owns a live artifact (#1832)", async () => {
    const o = await login(`own-${tag()}@example.com`, "owner");
    const other = await login(`own2-${tag()}@example.com`, "owner");
    expect((await get(o.cookie)).body?.hasArtifacts).toBe(false);
    const r = await api(app, R.artifacts, o.cookie, {
      method: "POST",
      body: { title: "first", format: "html", content: "<p>hi</p>" },
    });
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: string };
    expect((await get(o.cookie)).body?.hasArtifacts).toBe(true);
    expect((await get(other.cookie)).body?.hasArtifacts).toBe(false);
    expect(
      (await api(app, R.artifact(id), o.cookie, { method: "DELETE" })).status,
    ).toBeLessThan(300);
    expect((await get(o.cookie)).body?.hasArtifacts).toBe(false);
  });

  it("rejects a flag turned off or unknown fields", async () => {
    const o = await login(`own-${tag()}@example.com`, "owner");
    expect((await put(o.cookie, { dismissed: false })).status).toBe(400);
    expect((await put(o.cookie, { other: 1 })).status).toBe(400);
  });
});
