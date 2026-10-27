import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type Member, newId } from "@oa/shared";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { callerOf } from "../src/auth/authz.js";
import { DIRECTORY_SYNC_CRON, scheduled } from "../src/cron.js";
import type { Env } from "../src/env.js";
import { type ArtifactRuntime, runtimeStub } from "../src/runtime/do.js";
import {
  publish,
  REINDEX_BATCH,
  REINDEX_MIN_AGE_MS,
  reindexStale,
  restoreVersion,
  SWEEP_TICK_SPAN_MS,
  softDelete,
  sweepLostIndexJobs,
  undelete,
} from "../src/services/artifacts.js";
import { putExtractedText } from "../src/services/search.js";
import { getUser } from "../src/services/users.js";
import { login, runIndex } from "./helpers.js";

// Publish, restore and undelete enqueue indexing in waitUntil (the artifact
// DO's RPC is slow on hosted installs); sweepLostIndexJobs recovers a lost one.
const tag = newId().slice(0, 6).toLowerCase();
let owner: Member;
beforeAll(async () => {
  const l = await login(`sweep-${tag}@x.com`);
  const m = await getUser(env, l.userId);
  if (!m) throw new Error("no user");
  owner = m;
});
afterEach(() => vi.restoreAllMocks());

const withBrowser = {
  ...(env as Env),
  BROWSER: {} as Fetcher,
  SERVER_THUMBNAILS: "on",
} as Env;

type Hooks = {
  scheduleIndex?: (real: () => Promise<void>) => Promise<void>;
  closeSockets?: (real: () => Promise<void>) => Promise<void>;
};
/** env whose artifact DO stubs run `hooks` around the real RPCs. */
const hooked = (h: Hooks, base: Env = env as Env): Env => {
  const ns = base.ARTIFACT_RUNTIME;
  return {
    ...base,
    ARTIFACT_RUNTIME: {
      idFromName: (n: string) => ns.idFromName(n),
      get: (id: DurableObjectId) => {
        const real = ns.get(id) as unknown as ArtifactRuntime;
        return {
          scheduleIndex: (...a: Parameters<ArtifactRuntime["scheduleIndex"]>) =>
            (h.scheduleIndex ?? ((r) => r()))(() => real.scheduleIndex(...a)),
          closeSockets: (...a: Parameters<ArtifactRuntime["closeSockets"]>) =>
            (h.closeSockets ?? ((r) => r()))(async () => {
              // An RPC: the stub's call is async even though the method isn't.
              await real.closeSockets(...a);
            }),
        };
      },
    } as unknown as Env["ARTIFACT_RUNTIME"],
  };
};
const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => {
    open = r;
  });
  return { p, open };
};
const ctxOf = () => {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p) },
    drain: () => Promise.all(pending),
  };
};
/** "late" when `p` hasn't settled within `ms`. */
const within = <T>(p: Promise<T>, ms = 1500) =>
  Promise.race([
    p,
    new Promise<"late">((r) => setTimeout(() => r("late"), ms)),
  ]);
const inDo = <T>(
  id: string,
  cb: (i: ArtifactRuntime) => T | Promise<T>,
  e: Env = env as Env,
) =>
  runInDurableObject(
    runtimeStub(e, id) as unknown as DurableObjectStub<ArtifactRuntime>,
    (i) => {
      (i as unknown as { env: Env }).env = e;
      return cb(i);
    },
  );
const pending = (id: string) => inDo(id, (i) => i.pendingIndex());
const pendingThumb = (id: string) =>
  inDo(id, (i) => i.pendingThumbnail(), withBrowser);
const input = (format = "html", content = "<p>x</p>") =>
  ({ title: `t ${tag}`, format, content }) as never;
const age = (id: string, at: number) =>
  env.DB.prepare("update artifacts set updated_at = ? where id = ?")
    .bind(at, id)
    .run();
const dropping = hooked({
  scheduleIndex: async () => {
    throw new Error("enqueue lost");
  },
});
/** Publishes with the enqueue dropped (waitUntil drained): nothing queued. */
const lost = async (format = "html", content = "<p>x</p>") => {
  const c = ctxOf();
  const r = await publish(dropping, owner, input(format, content), null, c.ctx);
  await c.drain();
  expect(await pending(r.id)).toBeNull();
  return r.id;
};
const sweepLog = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls
    .map(([l]) => {
      try {
        return JSON.parse(String(l)) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((e) => e?.evt === "index_sweep");

describe("enqueue after the response", () => {
  it("publish and restore return before the DO answers; waitUntil queues the job", async () => {
    const g = gate();
    const slow = hooked({ scheduleIndex: (real) => g.p.then(real) });
    const c = ctxOf();
    const r = await within(publish(slow, owner, input(), null, c.ctx));
    if (r === "late") throw new Error("publish waited on the DO");
    expect(r.version).toBe(1);
    const back = await within(
      restoreVersion(slow, owner, r.id, 1, null, c.ctx),
    );
    if (back === "late") throw new Error("restore waited on the DO");
    expect(back.version).toBe(2);
    expect(c.pending).toHaveLength(2);
    expect(await pending(r.id)).toBeNull();
    g.open();
    await c.drain();
    expect(await pending(r.id)).toMatchObject({ artifactId: r.id, version: 2 });
  });

  it("undelete returns before the DO answers and queues the thumbnail job too", async () => {
    const r = await publish(env as Env, owner, input(), null);
    await softDelete(env as Env, owner, r.id);
    // Nothing pending; the DO's own env has server thumbnails on.
    await inDo(
      r.id,
      (i) => {
        const sql = (i as unknown as { sql: SqlStorage }).sql;
        sql.exec("delete from index_job");
        sql.exec("delete from thumb_job");
      },
      withBrowser,
    );
    const g = gate();
    const c = ctxOf();
    const slow = hooked({ scheduleIndex: (real) => g.p.then(real) });
    expect(await within(undelete(slow, owner, r.id, c.ctx))).not.toBe("late");
    g.open();
    await c.drain();
    expect(await pending(r.id)).toMatchObject({ version: 1 });
    expect(await pendingThumb(r.id)).toMatchObject({ version: 1 });
  });

  it("an access change still closes sockets before the response; the enqueue follows in waitUntil", async () => {
    const r = await publish(env as Env, owner, input(), null);
    const order: string[] = [];
    const closing = gate();
    const e = hooked({
      closeSockets: async (real) => {
        order.push("close");
        await closing.p;
        await real();
        order.push("closed");
      },
      scheduleIndex: async (real) => {
        order.push("enqueue");
        await real();
      },
    });
    const c = ctxOf();
    const p = publish(
      e,
      owner,
      { ...(input() as object), id: r.id, visibility: "public" } as never,
      null,
      c.ctx,
      "version",
    );
    expect(await within(p, 300)).toBe("late");
    expect(order).toEqual(["close"]);
    closing.open();
    expect((await p).version).toBe(2);
    expect(order).toEqual(["close", "closed", "enqueue"]);
    await c.drain();
    expect(await pending(r.id)).toMatchObject({ version: 2 });
  });
});

describe("sweepLostIndexJobs", () => {
  it("recovers a dropped enqueue: text and thumbnail of a non-pdf, the thumbnail of a pdf", async () => {
    const html = await lost("html", `<p>lost${tag}</p>`);
    const pdf = await lost("pdf", "%PDF-1.4");
    const now = Date.now() + 1000 * SWEEP_TICK_SPAN_MS;
    for (const id of [html, pdf]) {
      await age(id, now - REINDEX_MIN_AGE_MS - 60_000);
      // The DO reads its own env: server thumbnails on there too.
      await inDo(id, () => {}, withBrowser);
    }
    const spy = vi.spyOn(console, "log");
    const n = await sweepLostIndexJobs(withBrowser, now, "tick");
    expect(n).toEqual({ text: 1, thumb: 1 });
    expect(sweepLog(spy)).toEqual([
      { evt: "index_sweep", mode: "tick", text: 1, thumb: 1 },
    ]);
    for (const id of [html, pdf]) {
      expect(await pending(id)).toMatchObject({ artifactId: id, version: 1 });
      expect(await pendingThumb(id)).toMatchObject({ version: 1 });
    }
  });

  it("without server thumbnails, a pdf is left alone and the text sweep still runs", async () => {
    const html = await lost();
    const pdf = await lost("pdf", "%PDF-1.4");
    const now = Date.now() + 1010 * SWEEP_TICK_SPAN_MS;
    for (const id of [html, pdf]) await age(id, now - REINDEX_MIN_AGE_MS - 1);
    expect(await sweepLostIndexJobs(env as Env, now, "tick")).toEqual({
      text: 1,
      thumb: 0,
    });
    expect(await pending(pdf)).toBeNull();
    expect(await pending(html)).toMatchObject({ version: 1 });
  });

  it("is bounded, oldest first, and leaves fresh publishes and jobs that landed alone", async () => {
    const now = Date.now() + 1020 * SWEEP_TICK_SPAN_MS;
    const ids: string[] = [];
    for (let k = 0; k < REINDEX_BATCH + 3; k++) ids.push(await lost());
    // Oldest first: ids[0] is the oldest, all inside the tick window.
    for (const [k, id] of ids.entries())
      await age(id, now - REINDEX_MIN_AGE_MS - SWEEP_TICK_SPAN_MS + 1000 + k);
    const fresh = await lost();
    await age(fresh, now - REINDEX_MIN_AGE_MS + 1);
    // A pdf whose thumbnail of the current version exists: nothing to do.
    const done = await lost("pdf", "%PDF-1.4");
    await env.DB.prepare(
      "update artifacts set has_thumbnail = 1, thumbnail_version = 1, updated_at = ? where id = ?",
    )
      .bind(now - REINDEX_MIN_AGE_MS - 1, done)
      .run();
    const n = await sweepLostIndexJobs(withBrowser, now, "tick");
    expect(n).toEqual({ text: REINDEX_BATCH, thumb: 0 });
    for (const id of ids.slice(0, REINDEX_BATCH))
      expect(await pending(id)).toMatchObject({ version: 1 });
    for (const id of [...ids.slice(REINDEX_BATCH), fresh, done])
      expect(await pending(id)).toBeNull();
    // Once those ran, the next tick takes the rest; the fresh one still
    // waits for its own job.
    for (const id of ids.slice(0, REINDEX_BATCH)) await runIndex(id);
    expect(await sweepLostIndexJobs(withBrowser, now, "tick")).toEqual({
      text: 3,
      thumb: 0,
    });
    for (const id of ids.slice(REINDEX_BATCH))
      expect(await pending(id)).toMatchObject({ version: 1 });
    expect(await pending(fresh)).toBeNull();
  });

  it("a tick looks back only SWEEP_TICK_SPAN_MS; the daily sweep takes older ones", async () => {
    const now = Date.now() + 1030 * SWEEP_TICK_SPAN_MS;
    const old = await lost();
    await age(old, now - REINDEX_MIN_AGE_MS - SWEEP_TICK_SPAN_MS - 1);
    expect(await sweepLostIndexJobs(env as Env, now, "tick")).toEqual({
      text: 0,
      thumb: 0,
    });
    expect(await pending(old)).toBeNull();
    // Oldest first, so the daily batch takes it ahead of this file's others.
    await age(old, 0);
    expect(await reindexStale(env as Env, now)).toBeGreaterThanOrEqual(1);
    expect(await pending(old)).toMatchObject({ version: 1 });
  });

  it("oa:directory-sync runs the tick sweep in waitUntil and resolves", async () => {
    const id = await lost();
    await age(id, Date.now() - REINDEX_MIN_AGE_MS - 60_000);
    const c = ctxOf();
    const spy = vi.spyOn(console, "log");
    await expect(
      scheduled(
        { cron: DIRECTORY_SYNC_CRON },
        env as Env,
        c.ctx as unknown as ExecutionContext,
      ),
    ).resolves.toBeUndefined();
    expect(c.pending).toHaveLength(1);
    await c.drain();
    expect(sweepLog(spy)).toMatchObject([{ mode: "tick" }]);
    expect(await pending(id)).toMatchObject({ version: 1 });
  });

  it("logs nothing when there is nothing to re-enqueue", async () => {
    const spy = vi.spyOn(console, "log");
    expect(
      await sweepLostIndexJobs(
        withBrowser,
        Date.now() + 5000 * SWEEP_TICK_SPAN_MS,
        "tick",
      ),
    ).toEqual({ text: 0, thumb: 0 });
    expect(sweepLog(spy)).toEqual([]);
  });

  it("permanently failed versions don't hold the daily batch (text and pdf thumbnails)", async () => {
    const now = Date.now() + 1040 * SWEEP_TICK_SPAN_MS;
    const sixDays = now - 6 * 86_400_000;
    for (let k = 0; k < 25; k++) {
      const t = await lost();
      const p = await lost("pdf", "%PDF-1.4");
      await env.DB.batch([
        env.DB.prepare(
          "update versions set index_failed = 1 where artifact_id = ?",
        ).bind(t),
        env.DB.prepare(
          "update versions set thumb_failed = 1 where artifact_id = ?",
        ).bind(p),
      ]);
      await age(t, 1 + k);
      await age(p, sixDays + k);
    }
    const t = await lost();
    const p = await lost("pdf", "%PDF-1.4");
    await age(t, 1000);
    await age(p, sixDays + 1000);
    await inDo(p, () => {}, withBrowser);
    const n = await sweepLostIndexJobs(withBrowser, now, "daily");
    expect(n.text).toBeLessThanOrEqual(REINDEX_BATCH);
    expect(await pending(t)).toMatchObject({ version: 1 });
    expect(await pendingThumb(p)).toMatchObject({ version: 1 });
  });
});

describe("undelete with a lost enqueue (B1)", () => {
  const bodyOf = (id: string) =>
    env.DB.prepare("select body from artifact_search where artifact_id = ?")
      .bind(id)
      .first<string>("body");

  it("a non-pdf is unindexed again and the next tick recovers its body", async () => {
    const word = `undel${tag}`;
    const r = await publish(
      env as Env,
      owner,
      input("html", `<p>${word}</p>`),
      null,
    );
    await runIndex(r.id);
    expect(await bodyOf(r.id)).toContain(word);
    await softDelete(env as Env, owner, r.id);
    expect(await bodyOf(r.id)).toBeNull();
    const c = ctxOf();
    await undelete(dropping, owner, r.id, c.ctx);
    await c.drain();
    expect(await pending(r.id)).toBeNull();
    const u = await env.DB.prepare(
      "select updated_at u from artifacts where id = ?",
    )
      .bind(r.id)
      .first<number>("u");
    const n = await sweepLostIndexJobs(
      env as Env,
      (u ?? 0) + REINDEX_MIN_AGE_MS + 1,
      "tick",
    );
    expect(n.text).toBeGreaterThanOrEqual(1);
    expect(await pending(r.id)).toMatchObject({ version: 1 });
    await runIndex(r.id);
    expect(await bodyOf(r.id)).toContain(word);
  });

  it("a pdf takes a viewer's text again", async () => {
    const r = await publish(env as Env, owner, input("pdf", "%PDF-1.4"), null);
    const caller = callerOf(owner);
    await putExtractedText(env as Env, caller, r.id, 1, `first${tag}`);
    expect(await bodyOf(r.id)).toContain(`first${tag}`);
    await softDelete(env as Env, owner, r.id);
    await undelete(dropping, owner, r.id);
    await putExtractedText(env as Env, caller, r.id, 1, `again${tag}`);
    expect(await bodyOf(r.id)).toContain(`again${tag}`);
  });
});
