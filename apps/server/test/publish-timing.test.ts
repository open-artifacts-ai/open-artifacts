import { newId, PublishResultSchema, R } from "@oa/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { logPublishTiming } from "../src/services/artifacts.js";
import { api, login } from "./helpers.js";

// Hosted publishes stall at low CPU; one line per publish names the slow
// step. Ids and numbers only, never content.
const app = createApp();
afterEach(() => vi.restoreAllMocks());

const STEPS = ["checks_ms", "r2_ms", "batch_ms", "close_ms", "enqueue_ms"];

const timings = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls
    .map(([l]) => {
      try {
        return JSON.parse(String(l)) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((e) => e?.evt === "publish_timing");

describe("publish timing", () => {
  it("splits wall ms into steps that add up", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logPublishTiming(
      { INSTALL_ID: " i1 " },
      "a1",
      true,
      [100, 110, 140, 145, 145, 900],
    );
    expect(timings(spy)[0]).toEqual({
      evt: "publish_timing",
      install: "i1",
      artifactId: "a1",
      create: true,
      checks_ms: 10,
      r2_ms: 30,
      batch_ms: 5,
      close_ms: 0,
      enqueue_ms: 755,
      total_ms: 800,
    });
  });

  it("a real publish logs one line with ids and numbers only", async () => {
    const owner = await login(
      `timing-${newId().slice(0, 6).toLowerCase()}@example.test`,
    );
    const spy = vi.spyOn(console, "log");
    const secret = `content-${newId()}`;
    const r = await api(app, R.artifacts, owner.cookie, {
      method: "POST",
      body: { title: "T", format: "markdown", content: secret },
    });
    expect(r.status).toBe(201);
    const { id } = PublishResultSchema.parse(await r.json());
    const lines = timings(spy);
    expect(lines).toHaveLength(1);
    const [l] = lines;
    expect(l).toMatchObject({ artifactId: id, create: true });
    for (const k of [...STEPS, "total_ms"])
      expect(Number.isInteger(l?.[k]) && (l?.[k] as number) >= 0).toBe(true);
    const raw = JSON.stringify(l);
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain("example.test");
  });
});
