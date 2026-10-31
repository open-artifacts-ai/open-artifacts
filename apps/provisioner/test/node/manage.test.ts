// ManageInstall (design v7 5.4-5.7, 3.6, 10.1) on fake-cf: every kind, the
// rechecks and purge preconditions, replays, upgrade outcome mapping, the
// fail and cleanup compensation, redline_creds sealing. Each install is made
// by ProvisionInstall first, as in production.
import { HOSTED_DOMAINS, NAMESPACES } from "@oa/provision";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_PUBKEY } from "../../../../packages/provision/test/fixtures/release.js";
import { GRACE_MS, NEVER_ROUTED, runManage } from "../../src/manage.js";
import { openSealed } from "../../src/seal.js";
import { runCreate } from "../../src/workflow.js";
import {
  type CreateSeed,
  ENV,
  event,
  seedCreate,
  seedJob,
  stepRunner,
  V1,
  V2,
  type World,
  world,
} from "./world.js";

vi.mock(
  "../../../../packages/provision/src/internal/gates.js",
  async (orig) => ({
    ...(await orig<
      typeof import("../../../../packages/provision/src/internal/gates.js")
    >()),
    get RELEASE_PUBKEY() {
      return { staging: TEST_PUBKEY, prod: TEST_PUBKEY };
    },
  }),
);

let w: World;
beforeEach(async () => {
  w = await world();
});

async function active(o: CreateSeed) {
  const s = seedCreate(w, o);
  await runCreate(w.ctx, event(s.jobId), stepRunner(w.clock).step);
  expect(w.job(s.jobId)?.status).toBe("done");
  return s;
}

async function manage(
  kind: string,
  installId: string,
  o: Omit<Parameters<typeof seedJob>[1], "kind" | "installId"> & {
    twice?: boolean;
  } = {},
) {
  const id = seedJob(w, { kind, installId, ...o });
  const r = stepRunner(w.clock, { twice: o.twice });
  const error = await runManage(w.ctx, event(id), r.step).then(
    () => null,
    (x: unknown) => x as Error,
  );
  return { id, error, log: r.log, job: w.job(id) };
}

const plain = (id: string, name: string) =>
  (
    w.fake
      .script(NAMESPACES[ENV], `oa-s-${id}`)
      ?.metadata.bindings.find((b: { name: string }) => b.name === name) as
      | { text?: string }
      | undefined
  )?.text;

describe("upgrade and rollback (5.4)", () => {
  it("upgrade: on `to`, google kept (brokerEnabled); a replay of every step changes nothing", async () => {
    const s = await active({ slug: "upco", version: V1 });
    const r = await manage("upgrade", s.installId, {
      args: { from: V1, to: V2 },
      twice: true,
    });
    expect(r.error).toBeNull();
    expect(r.job).toMatchObject({ status: "done", step: "done" });
    expect(r.log.map((l) => l.name)).toEqual([
      "load",
      "recheck",
      "release_gate",
      "upload",
      "done",
    ]);
    expect(w.install(s.installId)).toMatchObject({
      version: V2,
      previous_version: V1,
      state: "active",
      lease: null,
    });
    expect(plain(s.installId, "AUTH_BROKER_URL")).toBe(
      `https://auth.${HOSTED_DOMAINS[ENV].app}`,
    );
    expect(plain(s.installId, "GOOGLE_CLIENT_ID")).toMatch(
      /apps\.googleusercontent\.com$/,
    );
    // Already on `to`: done with no Cloudflare write.
    const writes = w.fake.writes().length;
    const again = await manage("upgrade", s.installId, {
      args: { from: V1, to: V2 },
    });
    expect(again.job?.status).toBe("done");
    expect(again.log.map((l) => l.name)).toEqual(["load", "recheck", "done"]);
    expect(w.fake.writes().length).toBe(writes);
  });

  it("upgrade refusals: from moved is invalid_state; to at or below from is downgrade_refused", async () => {
    const s = await active({ slug: "refuseco" });
    const moved = await manage("upgrade", s.installId, {
      args: { from: V1, to: "0.25.0" },
    });
    expect(moved.job).toMatchObject({
      status: "failed",
      error_code: "invalid_state",
    });
    const down = await manage("upgrade", s.installId, {
      args: { from: V2, to: V1 },
    });
    expect(down.job).toMatchObject({
      status: "failed",
      error_code: "downgrade_refused",
    });
    expect(w.install(s.installId)?.version).toBe(V2);
  });

  it("an upgrade whose health fails rolls back: upgrade_rolled_back, still on from", async () => {
    const s = await active({ slug: "rbco", version: V1 });
    // Only the new version is unhealthy.
    w.fake.health = (sc) =>
      (sc.metadata.tags as string[]).includes(`v${V2}`)
        ? new Response(null, { status: 503 })
        : undefined;
    const r = await manage("upgrade", s.installId, {
      args: { from: V1, to: V2 },
    });
    w.fake.health = undefined;
    expect(r.job).toMatchObject({ status: "failed" });
    expect(r.job?.error_code).toBe("upgrade_rolled_back");
    expect(w.install(s.installId)).toMatchObject({
      version: V1,
      lease: null,
      state: "active",
    });
  });

  it("rollback: back on previous_version; a replay changes nothing", async () => {
    const s = await active({ slug: "backco", version: V1 });
    await manage("upgrade", s.installId, { args: { from: V1, to: V2 } });
    const r = await manage("rollback", s.installId, {
      args: { from: V2, to: V1 },
      twice: true,
    });
    expect(r.error).toBeNull();
    expect(w.install(s.installId)).toMatchObject({
      version: V1,
      state: "active",
    });
  });
});

describe("suspend, resume, delete, restore (5.5, 5.6)", () => {
  it("suspend pauses HOSTS and sign-in, then records; resume records, then serves", async () => {
    const s = await active({ slug: "pauseco" });
    const r = await manage("suspend", s.installId, {
      args: { reason: "billing" },
    });
    expect(r.error).toBeNull();
    expect(w.hosts("pauseco")).toEqual([
      `paused:${s.installId}`,
      `paused:${s.installId}`,
    ]);
    expect(w.signin(s.installId)?.disabled).toBe(true);
    expect(w.lifecycle(s.installId)).toMatchObject({
      serving_mode: "paused",
      suspended_at: expect.any(Number),
      suspend_reason: "billing",
    });
    expect(w.status(s.installId)?.state).toBe("suspended");
    // A second suspend is not a transition from suspended.
    expect(
      (await manage("suspend", s.installId, { args: { reason: "x" } })).job
        ?.error_code,
    ).toBe("invalid_state");
    const back = await manage("resume", s.installId, { twice: true });
    expect(back.error).toBeNull();
    expect(w.hosts("pauseco")).toEqual([s.installId, s.installId]);
    expect(w.signin(s.installId)?.disabled).toBeUndefined();
    expect(w.lifecycle(s.installId)).toMatchObject({
      serving_mode: "serving",
      suspended_at: null,
      suspend_reason: null,
    });
  });

  it("delete closes and starts the grace; restore reopens (paused if it was suspended)", async () => {
    const s = await active({ slug: "delco" });
    const d = await manage("delete", s.installId);
    expect(d.error).toBeNull();
    expect(w.hosts("delco")).toEqual([
      `closed:${s.installId}`,
      `closed:${s.installId}`,
    ]);
    const lc = w.lifecycle(s.installId) as {
      deleted_at: number;
      purge_at: number;
    };
    expect(lc.purge_at - lc.deleted_at).toBe(GRACE_MS);
    expect(w.status(s.installId)?.state).toBe("deleting");
    expect((await manage("restore", s.installId)).error).toBeNull();
    expect(w.hosts("delco")).toEqual([s.installId, s.installId]);
    expect(w.status(s.installId)?.state).toBe("active");

    await manage("suspend", s.installId, { args: { reason: "r" } });
    await manage("delete", s.installId);
    expect((await manage("restore", s.installId)).error).toBeNull();
    expect(w.hosts("delco")).toEqual([
      `paused:${s.installId}`,
      `paused:${s.installId}`,
    ]);
    expect(w.status(s.installId)?.state).toBe("suspended");
  });

  it("restore after purge_at is refused", async () => {
    const s = await active({ slug: "lateco" });
    await manage("delete", s.installId);
    w.clock.t += GRACE_MS + 1;
    const r = await manage("restore", s.installId);
    expect(r.job).toMatchObject({
      status: "failed",
      error_code: "invalid_state",
    });
    expect(w.hosts("lateco")).toEqual([
      `closed:${s.installId}`,
      `closed:${s.installId}`,
    ]);
    // The fail step reconciled the mode from HOSTS.
    expect(w.lifecycle(s.installId)?.serving_mode).toBe("closed");
  });

  it("a token may not run an admin-only kind (TRANSITIONS)", async () => {
    const s = await active({ slug: "tokco" });
    const r = await manage("release_lease", s.installId, { actor: "token" });
    expect(r.job?.error_code).toBe("invalid_state");
  });
});

describe("purge and discard (5.6, 2.5 item 4)", () => {
  it("an admin purge of a deleting install tears it down; no HOSTS key is left", async () => {
    const s = await active({ slug: "purgeco" });
    await manage("delete", s.installId);
    const r = await manage("purge", s.installId);
    expect(r.error).toBeNull();
    expect(w.install(s.installId)?.state).toBe("deleted");
    expect(w.hosts("purgeco")).toEqual([undefined, undefined]);
    expect(w.lifecycle(s.installId)?.serving_mode).toBe("unmapped");
    expect(w.status(s.installId)?.state).toBe("deleted");
  });

  it("the scheduler's purge waits for purge_at", async () => {
    const s = await active({ slug: "graceco" });
    await manage("delete", s.installId);
    const early = await manage("purge", s.installId, { actor: "system" });
    expect(early.job?.error_code).toBe("invalid_state");
    expect(w.install(s.installId)?.state).toBe("active");
    w.clock.t += GRACE_MS;
    expect(
      (await manage("purge", s.installId, { actor: "system" })).error,
    ).toBeNull();
    expect(w.install(s.installId)?.state).toBe("deleted");
  });

  it("purge is refused on an active install (delete accepts active; the recheck is the guard)", async () => {
    const s = await active({ slug: "liveco" });
    const r = await manage("purge", s.installId);
    expect(r.job?.error_code).toBe("invalid_state");
    expect(w.install(s.installId)?.state).toBe("active");
  });

  it("a prod_dirty create's own purge runs (system, never_routed skip, audited)", async () => {
    const s = seedCreate(w, { slug: "dirtyco" });
    w.fake.settingsEdit = (_x, b) => [...b, { name: "EXTRA", type: "service" }];
    await runCreate(w.ctx, event(s.jobId), stepRunner(w.clock).step).catch(
      () => {},
    );
    w.fake.settingsEdit = undefined;
    const purgeId = w.manage.created[0]?.id as string;
    const r = stepRunner(w.clock);
    await runManage(w.ctx, event(purgeId), r.step);
    expect(w.job(purgeId)?.status).toBe("done");
    expect(w.install(s.installId)?.state).toBe("deleted");
    expect(
      w.all(
        "SELECT detail FROM hosted_audit WHERE install_id = ? AND detail LIKE ?",
        s.installId,
        `%${NEVER_ROUTED}%`,
      ),
    ).not.toHaveLength(0);
  });

  it("discard: a failed create with no installs row is freed in D1 only", async () => {
    const s = seedCreate(w, { slug: "discardco", version: "0.30.0" });
    await runCreate(w.ctx, event(s.jobId), stepRunner(w.clock).step).catch(
      () => {},
    );
    expect(w.status(s.installId)?.state).toBe("failed");
    const writes = w.fake.writes().length;
    const r = await manage("discard", s.installId);
    expect(r.error).toBeNull();
    expect(w.status(s.installId)?.state).toBe("deleted");
    expect(w.fake.writes().length).toBe(writes);
  });
});

describe("retry (5.2, kind retry)", () => {
  it("a failed create retried by R12 reaches done under the same install and owner token label", async () => {
    const s = seedCreate(w, { slug: "retryco", version: "0.30.0" });
    await runCreate(w.ctx, event(s.jobId), stepRunner(w.clock).step).catch(
      () => {},
    );
    expect(w.status(s.installId)?.state).toBe("failed");
    // What R12 writes: a retry job, the signup queued again under it.
    const retry = seedJob(w, {
      kind: "retry",
      installId: s.installId,
      signupId: s.signupId,
    });
    w.db
      .prepare("UPDATE jobs SET workflow = 'provision_install' WHERE id = ?")
      .run(retry);
    w.db
      .prepare(
        "UPDATE signups SET job_id = ?, status = 'queued', version = NULL, error = NULL WHERE signup_id = ?",
      )
      .run(retry, s.signupId);
    await runCreate(w.ctx, event(retry), stepRunner(w.clock).step);
    expect(w.job(retry)?.status).toBe("done");
    expect(w.install(s.installId)?.state).toBe("active");
    expect(w.signup(s.signupId)?.status).toBe("ready");
  });
});

describe("release_lease and cleanup (3.6, R13, R25)", () => {
  it("release_lease drops an expired lease; a live one needs force", async () => {
    const s = await active({ slug: "leaseco" });
    w.db
      .prepare(
        "UPDATE installs SET lease = 'dead', lease_until = ? WHERE id = ?",
      )
      .run(w.clock.t + 60_000, s.installId);
    const live = await manage("release_lease", s.installId);
    expect(live.job?.status).toBe("failed");
    expect(
      (await manage("release_lease", s.installId, { args: { force: true } }))
        .error,
    ).toBeNull();
    expect(w.install(s.installId)?.lease).toBeNull();
  });

  it("cleanup of a canceled create: waits out the lease, releases it, settles the signup", async () => {
    const s = seedCreate(w, {
      slug: "cancelco",
      source: "self-serve",
      tier: "trial",
    });
    // R25: the job failed canceled, its cleanup inserted.
    w.db
      .prepare(
        "UPDATE jobs SET status = 'failed', error_code = 'canceled', finished_at = 1 WHERE id = ?",
      )
      .run(s.jobId);
    const r = await manage("cleanup", s.installId, {
      parentJobId: s.jobId,
      signupId: s.signupId,
    });
    expect(r.error).toBeNull();
    expect(r.log.map((l) => l.name)).toEqual([
      "load",
      "parent",
      "release_lease",
      "sweep_tokens",
      "settle",
      "done",
    ]);
    expect(r.job?.status).toBe("done");
    expect(w.signup(s.signupId)?.status).toBe("failed");
    expect(w.job(s.jobId)?.error_code).toBe("canceled");
    expect(
      w.get("SELECT freed_at FROM signup_accounts WHERE owner_sub = ?", s.sub),
    ).toEqual({
      freed_at: expect.any(Number),
    });
  });

  it("cleanup of a canceled upgrade left upgrading: sleeps to lease_until, then releases without force", async () => {
    const s = await active({ slug: "cupco" });
    const until = w.clock.t + 20 * 60_000;
    w.db
      .prepare(
        "UPDATE installs SET state = 'upgrading', lease = 'gone', lease_until = ? WHERE id = ?",
      )
      .run(until, s.installId);
    const parent = seedJob(w, {
      kind: "upgrade",
      installId: s.installId,
      status: "failed",
    });
    w.db
      .prepare("UPDATE jobs SET error_code = 'canceled' WHERE id = ?")
      .run(parent);
    const r = await manage("cleanup", s.installId, { parentJobId: parent });
    expect(r.error).toBeNull();
    expect(w.clock.t).toBeGreaterThan(until);
    expect(w.install(s.installId)).toMatchObject({
      state: "active",
      lease: null,
    });
  });
});

describe("redline_creds (10.1, R26)", () => {
  it("rotates TEST_HOOK_KEY, mints one redline- PAT after revoking older ones, seals {pat, hookKey}", async () => {
    const s = await active({ slug: "rl-a", actor: "oidc", testHooks: true });
    const script = w.fake.script(NAMESPACES[ENV], `oa-s-${s.installId}`);
    const oldKey = script?.secrets.get("TEST_HOOK_KEY");
    // The install's own API, as the CLI's test stubbed it.
    const tokens = [
      { id: "t1", label: "redline-old" },
      { id: "t2", label: "ci-1" },
    ];
    const deleted: string[] = [];
    const real = w.env.DISPATCHER;
    const seen: string[] = [];
    w.env.DISPATCHER = {
      get: (name: string) => ({
        fetch: async (req: Request) => {
          const u = new URL(req.url);
          seen.push(`${req.method} ${u.pathname}`);
          const key = script?.secrets.get("TEST_HOOK_KEY");
          if (u.pathname === "/__test/session")
            return req.headers.get("authorization") === `Bearer ${key}`
              ? Response.json({ cookie: "sess" })
              : new Response(null, { status: 401 });
          if (u.pathname === "/api/v1/tokens" && req.method === "GET")
            return Response.json(tokens);
          if (
            u.pathname.startsWith("/api/v1/tokens/") &&
            req.method === "DELETE"
          ) {
            deleted.push(u.pathname.split("/").at(-1) as string);
            return new Response(null, { status: 204 });
          }
          if (u.pathname === "/api/v1/tokens" && req.method === "POST")
            return Response.json(
              { token: "oa_pat_minted_secret_value" },
              { status: 201 },
            );
          if (u.pathname === "/api/v1/me")
            return req.headers.get("authorization") ===
              "Bearer oa_pat_minted_secret_value"
              ? Response.json({})
              : new Response(null, { status: 401 });
          return real.get(name).fetch(req);
        },
      }),
    } as unknown as DispatchNamespace;
    const pair = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    const raw = new Uint8Array(
      (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
    );
    const recipientKey = Buffer.from(raw).toString("base64url");
    const r = await manage("redline_creds", s.installId, {
      actor: "oidc",
      args: { recipientKey },
    });
    expect(r.error).toBeNull();
    expect(r.log.map((l) => l.name)).toEqual([
      "load",
      "recheck",
      "rotate_hook_key",
      "done",
    ]);
    const newKey = script?.secrets.get("TEST_HOOK_KEY") as string;
    expect(newKey).not.toBe(oldKey);
    expect(deleted).toEqual(["t1"]);
    const sealed = r.job?.sealed as string;
    expect(sealed).toMatch(/^oa-seal-v1\./);
    expect(JSON.parse(await openSealed(pair, sealed))).toEqual({
      pat: "oa_pat_minted_secret_value",
      hookKey: newKey,
    });
    // No credential in any step output or the job row's other columns.
    const text =
      JSON.stringify(r.log) + JSON.stringify({ ...r.job, sealed: null });
    expect(text).not.toContain("oa_pat_minted");
    expect(text).not.toContain(newKey);
    expect(seen).toContain("POST /__test/session");
  });

  it("is refused for a non-test install and in prod", async () => {
    const s = await active({ slug: "plainco" });
    const r = await manage("redline_creds", s.installId, {
      args: { recipientKey: "A".repeat(43) },
    });
    expect(r.job?.error_code).toBe("invalid_state");
  });
});
