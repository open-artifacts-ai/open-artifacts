import { env } from "cloudflare:workers";
import { newId } from "@oa/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enqueueIndex } from "../src/services/artifacts.js";

// Publish enqueues on the artifact DO in waitUntil; slow hosted installs need
// its wall time in the logs (no content, only ids and ms).
afterEach(() => vi.restoreAllMocks());

const events = (spy: { mock: { calls: unknown[][] } }, evt: string) =>
  spy.mock.calls
    .map(([l]) => {
      try {
        return JSON.parse(String(l)) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((e) => e?.evt === evt);

describe("index enqueue timing", () => {
  it("logs index_enqueue with the artifact id, wall ms and the DO's own ms", async () => {
    const spy = vi.spyOn(console, "log");
    const id = newId();
    await enqueueIndex(env, id, 1);
    const [e] = events(spy, "index_enqueue");
    expect(e).toMatchObject({ evt: "index_enqueue", artifactId: id });
    expect(Number.isInteger(e?.ms) && (e?.ms as number) >= 0).toBe(true);
    // The DO's share comes back over RPC (its console never reaches the tail).
    expect(Number.isInteger(e?.doMs) && (e?.doMs as number) >= 0).toBe(true);
    expect(e?.doMs as number).toBeLessThanOrEqual(e?.ms as number);
    expect(Object.keys(e ?? {}).sort()).toEqual(
      [
        "artifactId",
        "doMs",
        "evt",
        "ms",
        ...(env.INSTALL_ID?.trim() ? ["install"] : []),
      ].sort(),
    );
  });
});
