import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  insertPending,
  type ProvisionerClient,
  type ProvisionerProbe,
  parseProvisionerProbe,
  pollUntil,
  provisionerClient,
  removeSignup,
  SIGNUP_FIELDS,
  ulid,
} from "../src/provisioner.ts";
import { proof } from "../src/report.ts";
import { loadTargets, type Targets, verifyTarget } from "../src/targets.ts";

// SS3 red-line cases for the hosted provisioner (staging only). PENDING: this
// file sits outside live/, so the live suite never runs it, and its cases are
// not in live/manifest.json. A case that can't pass yet must not sit in the
// gate (Manager, 2026-10-29), and the gate counts every case that runs and
// every manifest entry. Enabling it, once oa-s-provisioner is deployed and
// REDLINE_STG_PROVISIONER is configured: move it to live/ and add both names
// to the manifest (docs/ops/hosted.md, "The provisioner").

let T: Targets;
let P: ProvisionerProbe | undefined;
let C: ProvisionerClient;
/** Signups this run wrote, removed in afterAll (never the fixture). */
const mine: string[] = [];

const NOT_CONFIGURED =
  "REDLINE_STG_PROVISIONER is not configured (the provisioner is not deployed)";

/**
 * How long a signup for a taken slug may take to end failed: reserve and
 * sweep, then create's check-first slug refusal, a terminal error. No resource
 * is made before that check, so minutes, not create's 45-minute attempt.
 */
const TAKEN_BOUND_MS = 10 * 60_000;
/**
 * How long a replay is watched. A ready row is acked on its first delivery
 * (max_batch_size 1, the default 5 s batch timeout); twice that, plus a
 * create start that a bug would make, is well inside a minute.
 */
const REPLAY_WATCH_MS = 60_000;

beforeAll(async () => {
  T = await loadTargets();
  if (T.mode !== "staging") return;
  P = parseProvisionerProbe();
  if (P) C = provisionerClient(P);
});

afterAll(async () => {
  for (const id of mine.splice(0)) await removeSignup(C, id);
});

describe("provisioner", () => {
  it(
    "a replayed signup creates nothing new",
    async (ctx) => {
      if (T.mode !== "staging")
        return proof(ctx, "staging-only", "needs the staging provisioner");
      if (!P) return proof(ctx, "unproven-live", NOT_CONFIGURED);
      const id = P.replaySignupId;
      const snap = async () => {
        const [s] = await C.query(
          `SELECT ${SIGNUP_FIELDS}, slug FROM signups WHERE signup_id = ?1`,
          [id],
        );
        const installs = s
          ? await C.query(
              "SELECT id, state, updated_at FROM installs WHERE slug = ?1 OR id = ?2 ORDER BY id",
              [s.slug, s.install_id],
            )
          : [];
        return JSON.stringify({ s, installs });
      };
      const before = await snap();
      const b = JSON.parse(before);
      if (b.s?.status !== "ready" || !b.s?.welcome_sent_at)
        return proof(
          ctx,
          "unproven-live",
          `the fixture signup is ${b.s ? b.s.status : "missing"}, not ready with its welcome sent`,
        );
      expect(b.installs).toHaveLength(1);
      // The same message twice, as a redelivery and a client retry would.
      await C.enqueue(id);
      await C.enqueue(id);
      // Every read in the window must match: a change that a later write
      // undoes is still a replay that did something.
      const seen = await pollUntil(snap, (v) => v !== before, REPLAY_WATCH_MS);
      expect(seen.met, "the replay changed the signup or its install").toBe(
        false,
      );
      expect(seen.value).toBe(before);
    },
    REPLAY_WATCH_MS + 60_000,
  );

  it(
    "a signup for a taken slug fails cleanly",
    async (ctx) => {
      if (T.mode !== "staging")
        return proof(ctx, "staging-only", "needs the staging provisioner");
      if (!P) return proof(ctx, "unproven-live", NOT_CONFIGURED);
      const [owner] = await C.query(
        "SELECT slug, state, updated_at FROM installs WHERE id = ?1",
        [T.a.installId],
      );
      expect(owner?.state, `${T.a.name} is active`).toBe("active");
      const slug = String(owner?.slug);
      const id = ulid();
      mine.push(id);
      await insertPending(C, {
        signupId: id,
        slug,
        ownerSub: `redline-${id}`,
        ownerEmail: `redline-signup@${T.a.testDomain}`,
      });
      await C.enqueue(id);
      const end = await pollUntil(
        async () =>
          (
            await C.query(
              `SELECT ${SIGNUP_FIELDS} FROM signups WHERE signup_id = ?1`,
              [id],
            )
          )[0],
        (r) => r?.status === "failed" || r?.status === "ready",
        TAKEN_BOUND_MS,
      );
      expect(end.met, "the signup ended within the bound").toBe(true);
      expect(end.value).toMatchObject({
        status: "failed",
        error: "slug_taken",
        welcome_claimed_at: null,
        welcome_sent_at: null,
      });
      // No half-made install: the slug still belongs to A alone, unchanged,
      // and the id reserve picked was never written as an install.
      expect(
        await C.query(
          "SELECT id, state, updated_at FROM installs WHERE slug = ?1",
          [slug],
        ),
      ).toEqual([
        { id: T.a.installId, state: "active", updated_at: owner?.updated_at },
      ]);
      const reserved = end.value?.install_id;
      if (reserved)
        expect(
          await C.query("SELECT id FROM installs WHERE id = ?1", [reserved]),
        ).toEqual([]);
      // A still serves as itself.
      await verifyTarget(T.a);
    },
    TAKEN_BOUND_MS + 60_000,
  );
});
