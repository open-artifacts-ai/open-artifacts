// #1188: the mock-parity cases (packages/shared/test/provisioning/
// mock-parity.ts) against the worker, through invokeRoute as an admin, on D1
// seeded with the MSW mock's own starting world (mockWorld).
import { mockWorld } from "@oa/shared/provisioning";
import { beforeEach } from "vitest";
import {
  mockParity,
  type ParityDriver,
} from "../../../packages/shared/test/provisioning/mock-parity.js";
import { call } from "./call.js";
import { ADMIN_P, fakeEnv, insert, jobId, next, resetDb } from "./fakes.js";

beforeEach(() => resetDb());

let auditSeeded = false;

/**
 * installs.state for a fixture's state, mapped one by one: a state the seed
 * doesn't know would otherwise seed as something else and hide the drift
 * this test is for. A failed create never got past creating; the view reads
 * it as failed.
 */
const installState = (s: string) => {
  if (s === "active") return "active";
  if (s === "failed") return "creating";
  throw new Error(`mock-parity seed: no installs.state for fixture state ${s}`);
};

/** D1 rows for the mock's world: installs, their jobs, and R17's rows. */
async function seedMockWorld() {
  const w = mockWorld();
  for (const d of w.installs) {
    await insert("installs", {
      id: d.id,
      slug: d.slug,
      app_host: d.appHost,
      content_host: d.contentHost,
      owner_email: d.ownerEmail ?? "",
      rl_ns: 8 * next(),
      inputs_hash: "h",
      version: d.version,
      previous_version: d.previousVersion,
      test_hooks: 0,
      state: installState(d.state),
      vars: JSON.stringify({
        AUTH_PROVIDERS: "google",
        AUTH_DOMAINS: "example.com",
        TIER: "team",
      }),
      created_at: d.createdAt,
      updated_at: d.createdAt,
    });
    await insert("install_lifecycle", {
      install_id: d.id,
      source: d.source,
      owner_sub: null,
      tier: "team",
      serving_mode: d.servingMode,
      health: d.health,
      created_at: d.createdAt,
      updated_at: d.createdAt,
    });
  }
  for (const j of w.jobs)
    await insert("jobs", {
      id: j.id,
      kind: j.kind,
      workflow: j.kind === "create" ? "provision_install" : "manage_install",
      install_id: j.installId,
      actor_kind: j.actor.kind,
      actor_key: `${j.actor.kind}:seed`,
      actor_label: j.actor.label,
      token_id: j.actor.tokenId,
      request_id: `seed-${j.id}`,
      body_hash: "h",
      args: JSON.stringify(j.args),
      status: j.status,
      step: j.step,
      created_at: j.createdAt,
      updated_at: j.createdAt,
    });
  // admin_audit and hosted_audit are append-only (triggers), so R17's rows go
  // in once per file; resetDb leaves them, and nothing here writes more.
  if (auditSeeded) return;
  auditSeeded = true;
  for (const { entry: e, tokenId } of w.audit)
    if (e.source === "provision")
      await insert("hosted_audit", {
        at: e.at,
        install_id: e.installId,
        action: e.action,
        detail: e.detail ? JSON.stringify(e.detail) : null,
      });
    else
      await insert("admin_audit", {
        at: e.at,
        actor_kind: e.actor.kind,
        actor_label: e.actor.label,
        token_id: tokenId,
        action: e.action,
        install_id: e.installId,
        job_id: e.jobId,
        outcome: e.outcome,
        code: e.code,
        detail: e.detail ? JSON.stringify(e.detail) : null,
      });
}

const e = fakeEnv();
const worker: ParityDriver = {
  mock: false,
  fresh: async () => {
    await resetDb();
    await seedMockWorld();
  },
  call: async (route, input = {}) => {
    const r = await call(e, ADMIN_P, route, input);
    return r.code
      ? { status: r.status, body: { error: { code: r.code } } }
      : { status: r.status, body: r.body };
  },
  // create's rows by hand (routes/create.ts: lifecycle, signup, its queued
  // job, signup_secret). R4 itself works here, but every accepted write adds
  // an admin_audit row, which is append-only, so resetDb can't take it back
  // and it would show in the R17 cases.
  addPendingSignup: async (slug, email) => {
    const id = `ipend${String(next()).padStart(7, "a")}`.slice(0, 12);
    const sid = jobId();
    await insert("install_lifecycle", {
      install_id: id,
      source: "admin",
      tier: "team",
      created_at: 1,
      updated_at: 1,
    });
    await insert("signups", {
      signup_id: sid,
      source: "admin",
      slug,
      job_id: sid,
      vars: JSON.stringify({ AUTH_PROVIDERS: "email", AUTH_DOMAINS: "" }),
      status: "pending",
      created_at: 1,
      updated_at: 1,
    });
    await insert("jobs", {
      id: sid,
      kind: "create",
      workflow: "provision_install",
      install_id: id,
      signup_id: sid,
      actor_kind: "admin",
      actor_key: "admin:seed",
      actor_label: "seed",
      request_id: `seed-${sid}`,
      body_hash: "h",
      args: "{}",
      status: "queued",
      created_at: 1,
      updated_at: 1,
    });
    await insert("signup_secret", { signup_id: sid, owner_email: email });
  },
};

mockParity(worker);
