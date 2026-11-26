import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { LIMITS, type Member, newId, R } from "@oa/shared";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { type ArtifactRuntime, runtimeStub } from "../src/runtime/do.js";
import { listVersionsWaiting, publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { api, login, runIndex } from "./helpers.js";

// GET versions `wait`: the request is held while the newest version's search
// index job is pending and answers when it settles (an event in the artifact's
// DO), or at the cap. The same access as the plain read, nothing written.
const app = createApp();
const tag = newId().slice(0, 6).toLowerCase().replace(/\d/g, "k");
let owner: { cookie: string; member: Member };
let other: { cookie: string; member: Member };

beforeAll(async () => {
  const l = await login(`vwait-${tag}@x.com`);
  const m = await getUser(env, l.userId);
  if (!m) throw new Error("no user");
  owner = { cookie: l.cookie, member: m };
  const o = await login(`vwait-other-${tag}@x.com`);
  const om = await getUser(env, o.userId);
  if (!om) throw new Error("no user");
  other = { cookie: o.cookie, member: om };
});
afterEach(() => vi.useRealTimers());

const pub = (input: Record<string, unknown>) =>
  publish(env, owner.member, input as never, null);
const inDo = <T>(id: string, cb: (i: ArtifactRuntime) => T | Promise<T>) =>
  runInDurableObject(
    runtimeStub(
      env as Env,
      id,
    ) as unknown as DurableObjectStub<ArtifactRuntime>,
    (i) => cb(i),
  );
const get = (id: string, cookie: string, before?: number, wait?: number) =>
  api(app, R.versions(id, before, wait), cookie);
const newest = async (r: Response) =>
  ((await r.json()) as { version: number; textIndexed: boolean }[])[0];
const waiters = (id: string) =>
  inDo(
    id,
    (i) => (i as unknown as { indexWaiters: Set<unknown> }).indexWaiters.size,
  );

describe("GET versions wait", () => {
  it("without wait, or with wait=0, it answers at once with the index still pending", async () => {
    const a = await pub({
      title: `p ${tag}`,
      format: "html",
      content: "<p>x</p>",
    });
    for (const w of [undefined, 0]) {
      const r = await get(a.id, owner.cookie, undefined, w);
      expect(r.status).toBe(200);
      expect(await newest(r)).toMatchObject({ version: 1, textIndexed: false });
    }
    expect(await waiters(a.id)).toBe(0);
  });

  it("a held request answers the moment the index job runs, not at the cap", async () => {
    const a = await pub({
      title: `h ${tag}`,
      format: "html",
      content: "<p>y</p>",
    });
    const t0 = Date.now();
    const held = get(a.id, owner.cookie, undefined, LIMITS.indexWaitMaxMs);
    await vi.waitFor(async () => expect(await waiters(a.id)).toBe(1));
    expect(await runIndex(a.id)).toBe(true);
    const r = await held;
    expect(r.status).toBe(200);
    expect(await newest(r)).toMatchObject({ version: 1, textIndexed: true });
    expect(Date.now() - t0).toBeLessThan(LIMITS.indexWaitMaxMs / 2);
    expect(await waiters(a.id)).toBe(0);
  });

  it("an already indexed version, and a page with `before`, are never held", async () => {
    const a = await pub({
      title: `i ${tag}`,
      format: "html",
      content: "<p>z</p>",
    });
    await pub({ id: a.id, format: "html", content: "<p>z2</p>" });
    await runIndex(a.id);
    const t0 = Date.now();
    const done = await get(a.id, owner.cookie, undefined, 25_000);
    expect(await newest(done)).toMatchObject({ version: 2, textIndexed: true });
    // One pending version, asked for as the page before v2: not the newest page.
    const b = await pub({
      title: `b ${tag}`,
      format: "html",
      content: "<p>q</p>",
    });
    const page = await get(b.id, owner.cookie, 2, 25_000);
    expect(page.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(await waiters(b.id)).toBe(0);
  });

  it("a newer version replacing the job answers a request held on the older one", async () => {
    const a = await pub({
      title: `r ${tag}`,
      format: "markdown",
      content: "one",
    });
    const held = inDo(a.id, (i) => i.whenIndexed(1, LIMITS.indexWaitMaxMs));
    await inDo(a.id, () => 0); // the hold is registered (RPCs run in order)
    expect(await waiters(a.id)).toBe(1);
    await pub({ id: a.id, format: "markdown", content: "two" });
    expect(await held).toBe(true);
  });

  it("the cap is honoured on the fake clock, and a larger ask is clamped to it", async () => {
    const a = await pub({
      title: `c ${tag}`,
      format: "html",
      content: "<p>w</p>",
    });
    // Inside the DO: its timer is its own, so the fake clock is installed and
    // advanced there, in the same context as the hold.
    await inDo(a.id, async (i) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        let outcome: boolean | undefined;
        const held = i.whenIndexed(1, 10 * LIMITS.indexWaitMaxMs).then((v) => {
          outcome = v;
        });
        await vi.advanceTimersByTimeAsync(LIMITS.indexWaitMaxMs - 1);
        expect(outcome).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        await held;
        expect(outcome).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
    expect(await waiters(a.id)).toBe(0);
  });

  it("access is the plain read's: a caller without access gets the same refusal, never a hold", async () => {
    const a = await pub({
      title: `a ${tag}`,
      format: "html",
      content: "<p>v</p>",
    });
    const plain = await get(a.id, other.cookie);
    const t0 = Date.now();
    const asked = await get(a.id, other.cookie, undefined, 20_000);
    expect(asked.status).toBe(plain.status);
    expect([403, 404]).toContain(asked.status);
    expect(await asked.text()).toBe(await plain.clone().text());
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(await waiters(a.id)).toBe(0);
  });

  it("the service refuses a caller without access before any hold", async () => {
    const a = await pub({
      title: `s ${tag}`,
      format: "html",
      content: "<p>k</p>",
    });
    const t0 = Date.now();
    await expect(
      listVersionsWaiting(
        env as Env,
        { kind: "user", user: other.member },
        a.id,
        undefined,
        LIMITS.indexWaitMaxMs,
      ),
    ).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(await waiters(a.id)).toBe(0);
  });

  it("wait must be a non-negative integer", async () => {
    const a = await pub({
      title: `w ${tag}`,
      format: "html",
      content: "<p>u</p>",
    });
    for (const bad of ["-1", "1.5", "abc", "", "9999999999"]) {
      const r = await api(app, `${R.versions(a.id)}?wait=${bad}`, owner.cookie);
      expect(r.status, bad).toBe(400);
    }
  });

  it("holding writes nothing: the pending job is the one it found", async () => {
    const a = await pub({
      title: `n ${tag}`,
      format: "html",
      content: "<p>t</p>",
    });
    const before = await inDo(a.id, (i) => i.pendingIndex());
    const held = get(a.id, owner.cookie, undefined, LIMITS.indexWaitMaxMs);
    await vi.waitFor(async () => expect(await waiters(a.id)).toBe(1));
    expect(await inDo(a.id, (i) => i.pendingIndex())).toEqual(before);
    await runIndex(a.id);
    await held;
  });
});
