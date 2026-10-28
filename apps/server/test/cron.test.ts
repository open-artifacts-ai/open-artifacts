import { env } from "cloudflare:workers";
import { newId } from "@oa/shared";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { scheduled } from "../src/cron.js";
import worker from "../src/index.js";
import { publish, purgeDeleted } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { login } from "./helpers.js";

const DAY = 86400_000;
const tag = newId().slice(0, 6).toLowerCase();
let user: NonNullable<Awaited<ReturnType<typeof getUser>>>;

const mk = async (title: string, daysAgo: number) => {
  const r = await publish(
    env,
    user,
    { title, format: "markdown", content: title } as never,
    null,
  );
  await publish(
    env,
    user,
    { id: r.id, format: "markdown", content: `${title} 2` } as never,
    null,
  );
  await env.FILES.put(`thumbs/${r.id}.webp`, new Uint8Array([1]));
  // Publish left an FTS row (B8); purge must remove it.
  await env.DB.prepare("update artifacts set deleted_at = ? where id = ?")
    .bind(Date.now() - daysAgo * DAY, r.id)
    .run();
  return r.id;
};
const count = async (sql: string, id: string) =>
  (await env.DB.prepare(sql).bind(id).first<{ n: number }>())?.n;
const r2Keys = async (id: string) =>
  (await env.FILES.list({ prefix: `files/${id}/` })).objects.length;

beforeAll(async () => {
  const l = await login(`cron-${tag}@x.com`);
  const u = await getUser(env, l.userId);
  if (!u) throw new Error("no user");
  user = u;
});

describe("purgeDeleted", () => {
  it("purges artifacts deleted 31 days ago and keeps 29-day-old ones", async () => {
    const gone = await mk("gone", 31);
    const kept = await mk("kept", 29);
    expect(await r2Keys(gone)).toBe(2);

    const n = await purgeDeleted(env, Date.now());
    expect(n).toBeGreaterThanOrEqual(1);

    expect(await r2Keys(gone)).toBe(0);
    expect(await env.FILES.head(`thumbs/${gone}.webp`)).toBeNull();
    expect(
      await count("select count(*) n from artifacts where id = ?", gone),
    ).toBe(0);
    expect(
      await count(
        "select count(*) n from versions where artifact_id = ?",
        gone,
      ),
    ).toBe(0);
    expect(
      await count(
        "select count(*) n from artifact_search where artifact_id = ?",
        gone,
      ),
    ).toBe(0);

    expect(await r2Keys(kept)).toBe(2);
    expect(await env.FILES.head(`thumbs/${kept}.webp`)).not.toBeNull();
    expect(
      await count("select count(*) n from artifacts where id = ?", kept),
    ).toBe(1);
    expect(
      await count(
        "select count(*) n from versions where artifact_id = ?",
        kept,
      ),
    ).toBe(2);
  });

  it("scheduled() runs purge and sweep under ctx.waitUntil, and index wires it", async () => {
    const gone = await mk("gone2", 40);
    const waits: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      passThroughOnException() {},
    } as unknown as ExecutionContext;
    expect(worker.scheduled).toBe(scheduled);
    // B3's release check: no real network from tests.
    const f = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("", { status: 429 }));
    await scheduled({} as ScheduledController, env, ctx);
    expect(waits).toHaveLength(1);
    const settled = (await waits[0]) as PromiseSettledResult<unknown>[];
    f.mockRestore();
    expect(settled.map((s) => s.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "fulfilled",
      "fulfilled", // sweepOAuthStore (expired rows, old tombstones)
      "fulfilled", // C3: reindexStale
      "fulfilled", // sweepEmailCounters
      "fulfilled", // sweepLoginCodes (P2)
      "fulfilled", // checkLatestRelease (B3)
      "fulfilled", // expirePending (P3 T12 directory confirm)
      "fulfilled", // sweepAuditEvents (400-day audit retention)
      "fulfilled", // kickSync (P3 T13; a no-op with sync off)
    ]);
    expect(
      await count("select count(*) n from artifacts where id = ?", gone),
    ).toBe(0);
  });
});
