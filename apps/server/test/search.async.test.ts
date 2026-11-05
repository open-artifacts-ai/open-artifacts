import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  LIMITS,
  type Member,
  newId,
  PageSchema,
  R,
  SearchHitSchema,
} from "@oa/shared";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import {
  type ArtifactRuntime,
  INDEX_DELAY_MS,
  INDEX_MAX_ATTEMPTS,
  indexBackoffMs,
  runtimeStub,
} from "../src/runtime/do.js";
import {
  patch,
  publish,
  REINDEX_BATCH,
  reindexStale,
  restoreVersion,
  softDelete,
  undelete,
} from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { api, login, runIndex } from "./helpers.js";

// C3: publish/restore/undelete enqueue indexing on the artifact's DO; its alarm indexes.
const app = createApp();
const tag = newId().slice(0, 6).toLowerCase().replace(/\d/g, "k");
const Hits = PageSchema(SearchHitSchema);
let o: { cookie: string; member: Member };

beforeAll(async () => {
  const l = await login(`async-${tag}@x.com`);
  const m = await getUser(env, l.userId);
  if (!m) throw new Error("no user");
  o = { cookie: l.cookie, member: m };
});
afterEach(() => vi.restoreAllMocks());

const pub = (input: Record<string, unknown>) =>
  publish(env, o.member, input as never, null);
const found = async (q: string) => {
  const r = await api(app, `${R.search}?q=${encodeURIComponent(q)}`, o.cookie);
  expect(r.status).toBe(200);
  return Hits.parse(await r.json()).items.map((h) => h.id);
};
const inDo = <T>(
  id: string,
  cb: (i: ArtifactRuntime, s: DurableObjectState) => T | Promise<T>,
) =>
  runInDurableObject(
    runtimeStub(
      env as Env,
      id,
    ) as unknown as DurableObjectStub<ArtifactRuntime>,
    cb,
  );
const textIndexed = async (id: string, v: number) =>
  (
    await env.DB.prepare(
      "select text_indexed as t from versions where artifact_id = ? and version = ?",
    )
      .bind(id, v)
      .first<{ t: number }>()
  )?.t;

describe("async search indexing (C3)", () => {
  it("publish returns without indexing; the alarm makes the body searchable", async () => {
    const t0 = Date.now();
    const a = await pub({
      title: `Plain ${tag}`,
      format: "html",
      content: `<p>bodyword${tag}</p>`,
    });
    // Not indexed yet: title only, a pending job, an alarm armed for it.
    expect(await textIndexed(a.id, 1)).toBe(0);
    expect(await found(`bodyword${tag}`)).toEqual([]);
    expect(await found(`plain ${tag}`)).toEqual([a.id]);
    const job = await inDo(a.id, (i) => i.pendingIndex());
    expect(job).toMatchObject({ artifactId: a.id, version: 1, attempts: 0 });
    expect(job?.due).toBeGreaterThanOrEqual(t0 + INDEX_DELAY_MS);
    expect(await inDo(a.id, (_i, s) => s.storage.getAlarm())).toBe(job?.due);

    expect(await runIndex(a.id)).toBe(true);
    expect(await found(`bodyword${tag}`)).toEqual([a.id]);
    expect(await textIndexed(a.id, 1)).toBe(1);
    expect(await inDo(a.id, (i) => i.pendingIndex())).toBeNull();
    // Nothing pending, no socket: no alarm left.
    expect(await runIndex(a.id)).toBe(false);
  });

  it("debounces 10 s: bursts coalesce, off the publishing isolate", () => {
    expect(INDEX_DELAY_MS).toBe(LIMITS.indexDebounceMs);
    expect(INDEX_DELAY_MS).toBe(10_000);
  });

  it("a newer version supersedes an older pending one (one index run)", async () => {
    const a = await pub({
      title: "v",
      format: "markdown",
      content: `firstver${tag}`,
    });
    await pub({ id: a.id, format: "markdown", content: `secondver${tag}` });
    expect(await inDo(a.id, (i) => i.pendingIndex())).toMatchObject({
      version: 2,
    });
    // An older version scheduled late is ignored.
    await runtimeStub(env as Env, a.id).scheduleIndex(a.id, 1);
    expect(await inDo(a.id, (i) => i.pendingIndex())).toMatchObject({
      version: 2,
    });
    const calls: number[] = [];
    await inDo(a.id, (i) => {
      const real = i.indexer;
      i.indexer = (e, id, v) => {
        calls.push(v);
        return real(e, id, v);
      };
    });
    await runIndex(a.id);
    expect(calls).toEqual([2]);
    expect(await found(`secondver${tag}`)).toEqual([a.id]);
    expect(await found(`firstver${tag}`)).toEqual([]);
    expect(await textIndexed(a.id, 1)).toBe(0);
  });

  it("restore enqueues the restored version", async () => {
    const a = await pub({
      title: "r",
      format: "markdown",
      content: `rone${tag}`,
    });
    await pub({ id: a.id, format: "markdown", content: `rtwo${tag}` });
    await runIndex(a.id);
    await restoreVersion(env, o.member, a.id, 1, null);
    // Until indexed, the previous version's body still matches.
    expect(await found(`rtwo${tag}`)).toEqual([a.id]);
    await runIndex(a.id);
    expect(await found(`rone${tag}`)).toEqual([a.id]);
    expect(await found(`rtwo${tag}`)).toEqual([]);
  });

  it("a soft-deleted artifact isn't indexed; undelete re-enqueues", async () => {
    const a = await pub({
      title: `Gone ${tag}`,
      format: "markdown",
      content: `deadword${tag}`,
    });
    await softDelete(env, o.member, a.id);
    await runIndex(a.id);
    expect(await textIndexed(a.id, 1)).toBe(0);
    const row = await env.DB.prepare(
      "select count(*) as n from artifact_search where artifact_id = ?",
    )
      .bind(a.id)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
    await undelete(env, o.member, a.id);
    // Title right away, body after the alarm.
    expect(await found(`gone ${tag}`)).toEqual([a.id]);
    expect(await found(`deadword${tag}`)).toEqual([]);
    await runIndex(a.id);
    expect(await found(`deadword${tag}`)).toEqual([a.id]);
  });

  it("PATCH title/description stays synchronous", async () => {
    const a = await pub({ title: "x", format: "markdown", content: "y" });
    await patch(env, o.member, a.id, { title: `Renamed ${tag}` });
    expect(await found(`renamed ${tag}`)).toEqual([a.id]);
  });

  it("failures retry with backoff, then log index_failed after 5 attempts", async () => {
    const a = await pub({
      title: "f",
      format: "markdown",
      content: `retryword${tag}`,
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = Date.now();
    let fail = true;
    await inDo(a.id, (i) => {
      const real = i.indexer;
      i.now = () => t;
      i.indexer = (e, id, v) =>
        fail ? Promise.reject(new Error("R2 down")) : real(e, id, v);
    });
    // Attempt 1 fails → retry at +10 s.
    await runIndex(a.id);
    let job = await inDo(a.id, (i) => i.pendingIndex());
    expect(job).toMatchObject({ attempts: 1, due: t + indexBackoffMs(1) });
    expect(await inDo(a.id, (_i, s) => s.storage.getAlarm())).toBe(job?.due);
    // Fired before the backoff is due: no attempt.
    await runIndex(a.id);
    expect(await inDo(a.id, (i) => i.pendingIndex())).toMatchObject({
      attempts: 1,
    });
    // Attempts 2..4 fail at their due times.
    for (let n = 1; n < INDEX_MAX_ATTEMPTS - 1; n++) {
      const due = job?.due ?? 0;
      await inDo(a.id, (i) => {
        i.now = () => due;
      });
      await runIndex(a.id);
      job = await inDo(a.id, (i) => i.pendingIndex());
      expect(job).toMatchObject({
        attempts: n + 1,
        due: due + indexBackoffMs(n + 1),
      });
    }
    expect(err).not.toHaveBeenCalledWith(
      expect.stringContaining("index_failed"),
    );
    // Attempt 5 fails: dropped and logged.
    const due = job?.due ?? 0;
    await inDo(a.id, (i) => {
      i.now = () => due;
    });
    await runIndex(a.id);
    expect(await inDo(a.id, (i) => i.pendingIndex())).toBeNull();
    const logged = err.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes('"evt":"index_failed"'));
    expect(JSON.parse(logged ?? "{}")).toMatchObject({
      evt: "index_failed",
      artifactId: a.id,
      version: 1,
      attempts: INDEX_MAX_ATTEMPTS,
    });
    expect(await found(`retryword${tag}`)).toEqual([]);
    // Marked, so the lost-job sweep skips it.
    expect(
      await env.DB.prepare(
        "select index_failed f from versions where artifact_id = ? and version = 1",
      )
        .bind(a.id)
        .first("f"),
    ).toBe(1);

    // A retry that succeeds indexes.
    fail = false;
    await pub({ id: a.id, format: "markdown", content: `retryword${tag}` });
    await runIndex(a.id);
    expect(await found(`retryword${tag}`)).toEqual([a.id]);
  });

  it("the index alarm and the socket-lifetime alarm share one alarm", async () => {
    const a = await pub({ title: "s", format: "markdown", content: "s" });
    const job = await inDo(a.id, (i) => i.pendingIndex());
    await inDo(a.id, async (i, s) => {
      // A socket's later TTL never pushes the index alarm out.
      await (i as unknown as { armAt(t: number): Promise<void> }).armAt(
        Date.now() + 600_000,
      );
      expect(await s.storage.getAlarm()).toBe(job?.due);
    });
    await runIndex(a.id);
    expect(await inDo(a.id, (i) => i.pendingIndex())).toBeNull();
  });

  it("cron re-enqueues a current non-pdf version left unindexed (lost enqueue)", async () => {
    const a = await pub({
      title: "lost",
      format: "markdown",
      content: `lostword${tag}`,
    });
    // Lose the job: nothing pending, never indexed, old enough.
    await inDo(a.id, async (i, s) => {
      (i as unknown as { sql: SqlStorage }).sql.exec("delete from index_job");
      await s.storage.deleteAlarm();
    });
    await env.DB.prepare("update artifacts set updated_at = 0 where id = ?")
      .bind(a.id)
      .run();
    expect(await inDo(a.id, (i) => i.pendingIndex())).toBeNull();
    const n = await reindexStale(env as Env, Date.now());
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(REINDEX_BATCH);
    expect(await inDo(a.id, (i) => i.pendingIndex())).toMatchObject({
      version: 1,
    });
    await runIndex(a.id);
    expect(await found(`lostword${tag}`)).toEqual([a.id]);
  });

  it("an alarm with nothing pending returns early; destroy clears the alarm", async () => {
    const a = await pub({ title: "d", format: "markdown", content: "d" });
    await runIndex(a.id);
    await inDo(a.id, async (i, s) => {
      expect(i.pendingIndex()).toBeNull();
      await s.storage.deleteAlarm();
      const set = vi.spyOn(s.storage, "setAlarm");
      await i.alarm();
      // Nothing pending, no sockets: no work, not re-armed.
      expect(set).not.toHaveBeenCalled();
      expect(await s.storage.getAlarm()).toBeNull();
    });
    await runtimeStub(env as Env, a.id).scheduleIndex(a.id, 1);
    await runtimeStub(env as Env, a.id).destroy();
    expect(await inDo(a.id, (_i, s) => s.storage.getAlarm())).toBeNull();
  });
});
