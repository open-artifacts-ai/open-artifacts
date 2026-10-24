// P3 Task 7a: the UserPresence DO class on its own (closes are faked here;
// the socket paths are in presence.test.ts).
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { newId } from "@oa/shared";
import { describe, expect, it } from "vitest";
import {
  CLOSE_FANOUT,
  presenceStub,
  RETRY_MAX_AGE_MS,
  retryBackoffMs,
  SKEW_MS,
  type UserPresence,
} from "../src/runtime/presence.js";

const presence = (userId: string) => {
  const ns = env.USER_PRESENCE;
  if (!ns) throw new Error("USER_PRESENCE unbound");
  return ns.get(ns.idFromName(userId));
};
const inPresence = <T>(
  userId: string,
  cb: (p: UserPresence) => T | Promise<T>,
) =>
  runInDurableObject(
    presence(userId) as unknown as DurableObjectStub<UserPresence>,
    cb,
  );
/**
 * A clock an hour ahead for queue tests: queued closes fall due then, so the
 * runtime never fires the alarm on its own mid-test (runDurableObjectAlarm
 * runs it on demand).
 */
const later = () => Date.now() + 3_600_000;

describe("UserPresence (class)", () => {
  it("touch records until a revocation; then refuses authzAt <= revokedAt + SKEW_MS", async () => {
    const uid = `pc-touch-${newId()}`;
    const now = Date.now();
    const r = await inPresence(uid, async (p) => {
      p.now = () => now;
      const first = p.touch("art-1", now - 10).ok;
      p.closer = async () => 1;
      await p.closeAll("suspended");
      const at = p.revokedAt() as number;
      return {
        first,
        at,
        before: p.touch("art-1", at - 1).ok,
        same: p.touch("art-1", at).ok,
        inSkew: p.touch("art-1", at + SKEW_MS).ok,
        after: p.touch("art-1", at + SKEW_MS + 1).ok,
      };
    });
    expect(r).toEqual({
      first: true,
      at: now,
      before: false,
      same: false,
      inSkew: false,
      after: true,
    });
  });

  it("closeAll sets revokedAt before any closeActor call", async () => {
    const uid = `pc-order-${newId()}`;
    const seen: (number | null)[] = [];
    const n = await inPresence(uid, async (p) => {
      p.touch("art-a", Date.now());
      p.touch("art-b", Date.now());
      p.closer = async () => {
        seen.push(p.revokedAt());
        return 1;
      };
      return p.closeAll("suspended");
    });
    expect(n).toBe(2);
    expect(seen).toHaveLength(2);
    for (const t of seen) expect(t).toEqual(expect.any(Number));
  });

  it("closeAll closes as the DO's user (u:{name})", async () => {
    const uid = `pc-actor-${newId()}`;
    const actors = await inPresence(uid, async (p) => {
      const got: string[] = [];
      p.touch("art-a", Date.now());
      p.closer = async (_e, _id, actor) => {
        got.push(actor);
        return 1;
      };
      await p.closeAll("suspended");
      return got;
    });
    expect(actors).toEqual([`u:${uid}`]);
  });

  it("a failed close is retried from the queue by the alarm", async () => {
    const uid = `pc-retry-${newId()}`;
    let calls = 0;
    const base = later();
    await inPresence(uid, async (p) => {
      p.now = () => base;
      p.touch("art-r", base);
      p.closer = async () => {
        if (++calls === 1) throw new Error("boom");
        return 1;
      };
      expect(await p.closeAll("suspended")).toBe(0);
      expect(p.pendingRetries()).toMatchObject([
        { artifactId: "art-r", attempts: 1, due: base + retryBackoffMs(1) },
      ]);
      p.now = () => base + retryBackoffMs(1);
    });
    expect(await runDurableObjectAlarm(presence(uid))).toBe(true);
    expect(calls).toBe(2);
    expect(await inPresence(uid, (p) => p.pendingRetries())).toEqual([]);
  });

  it("failures back off and are dropped once 11 minutes old", async () => {
    const uid = `pc-expire-${newId()}`;
    const t0 = later();
    await inPresence(uid, async (p) => {
      p.now = () => t0;
      p.touch("art-x", t0);
      p.closer = async () => {
        throw new Error("down");
      };
      await p.closeAll("suspended");
      p.now = () => t0 + retryBackoffMs(1);
    });
    await runDurableObjectAlarm(presence(uid));
    const [r] = await inPresence(uid, (p) => p.pendingRetries());
    expect(r).toMatchObject({ attempts: 2, due: t0 + retryBackoffMs(1) * 3 });
    await inPresence(uid, (p) => {
      p.now = () => t0 + RETRY_MAX_AGE_MS + 1;
    });
    await runDurableObjectAlarm(presence(uid));
    expect(await inPresence(uid, (p) => p.pendingRetries())).toEqual([]);
  });

  it("closes past CLOSE_FANOUT wait in the queue for the alarm", async () => {
    const uid = `pc-fan-${newId()}`;
    let calls = 0;
    const base = later();
    await inPresence(uid, async (p) => {
      p.now = () => base;
      for (let i = 0; i < CLOSE_FANOUT + 3; i++) p.touch(`art-${i}`, 1);
      p.closer = async () => {
        calls++;
        return 0;
      };
      await p.closeAll("removed");
      expect(calls).toBe(CLOSE_FANOUT);
      expect(p.pendingRetries()).toHaveLength(3);
    });
    expect(await runDurableObjectAlarm(presence(uid))).toBe(true);
    expect(calls).toBe(CLOSE_FANOUT + 3);
    expect(await inPresence(uid, (p) => p.pendingRetries())).toEqual([]);
  });

  it("presenceStub is null without the binding", () => {
    expect(presenceStub({ USER_PRESENCE: undefined }, "u1")).toBeNull();
    expect(presenceStub(env, "u1")).not.toBeNull();
  });
});
