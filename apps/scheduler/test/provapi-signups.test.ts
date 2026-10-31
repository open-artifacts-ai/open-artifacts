import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { DutyFailure, type ProvapiEnv } from "../src/provapi/env.js";
import {
  SIGNUP_STALE_MS,
  SIGNUPS_LIMIT,
  SIGNUPS_ON,
  signupsDue,
} from "../src/provapi/signups.js";
import { captureLogs, db, migrate, reset, signup } from "./provapi/db.js";

beforeAll(migrate);
beforeEach(reset);
afterEach(() => vi.restoreAllMocks());

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 9, 31, 0, 4);
const TODAY = Math.floor(NOW / DAY_MS) * DAY_MS;

function fakes(over: Partial<ProvapiEnv> = {}) {
  const sent: unknown[][] = [];
  const queue = {
    send: async () => {},
    sendBatch: async (msgs: { body: unknown }[]) => {
      sent.push(msgs.map((m) => m.body));
    },
  } as unknown as Queue<{ signupId: string }>;
  const env = {
    PLATFORM_DB: db,
    OA_ENV: "staging",
    SIGNUPS: queue,
    SIGNUPS_ENABLED: "true",
    SIGNUP_DAILY_CAP: "2",
    ...over,
  } as unknown as ProvapiEnv;
  return { env, sent: () => sent.flat() };
}

const selfServe = (o: Record<string, string | number | null>) =>
  signup({ source: "self-serve", owner_sub: "sub", ...o });

describe("signups duty", () => {
  it("re-sends waiting_cap rows, oldest first, up to the day's remaining cap ({ signupId } only)", async () => {
    // One self-serve admission today already: one slot left of 2.
    await selfServe({ status: "queued", admitted_at: TODAY + 1 });
    // An admin admission today does not count against the cap.
    await signup({ status: "queued", admitted_at: TODAY + 1 });
    const a = await selfServe({ status: "waiting_cap", created_at: 1 });
    await selfServe({ status: "waiting_cap", created_at: 2 });
    const f = fakes();
    const lines = captureLogs(vi.spyOn);
    await signupsDue(f.env, NOW);
    expect(f.sent()).toEqual([{ signupId: a }]);
    expect(lines).toEqual(["provapi signups stale=0 requeued=1"]);
  });

  it("the cap reached today: nothing is re-sent until the next UTC day", async () => {
    await selfServe({ status: "queued", admitted_at: TODAY + 1 });
    await selfServe({ status: "creating", admitted_at: TODAY + 2 });
    const w = await selfServe({ status: "waiting_cap" });
    const f = fakes();
    captureLogs(vi.spyOn);
    await signupsDue(f.env, NOW);
    expect(f.sent()).toEqual([]);
    await signupsDue(f.env, TODAY + DAY_MS);
    expect(f.sent()).toEqual([{ signupId: w }]);
  });

  it("no cap configured: waiting_cap rows are not re-sent", async () => {
    await selfServe({ status: "waiting_cap" });
    const f = fakes({ SIGNUP_DAILY_CAP: undefined });
    await signupsDue(f.env, NOW);
    expect(f.sent()).toEqual([]);
  });

  it("re-sends a self-serve pending row untouched for SIGNUP_STALE_MS (its message was lost)", async () => {
    const old = await selfServe({
      status: "pending",
      updated_at: NOW - SIGNUP_STALE_MS - 1,
    });
    await selfServe({ status: "pending", updated_at: NOW - SIGNUP_STALE_MS });
    await signup({ status: "pending", updated_at: 1 });
    await selfServe({ status: "queued", updated_at: 1 });
    const f = fakes();
    captureLogs(vi.spyOn);
    await signupsDue(f.env, NOW);
    expect(f.sent()).toEqual([{ signupId: old }]);
  });

  it(`at most ${SIGNUPS_LIMIT} stale rows per tick`, async () => {
    for (let n = 0; n <= SIGNUPS_LIMIT; n++)
      await selfServe({ status: "pending", updated_at: n });
    const f = fakes();
    captureLogs(vi.spyOn);
    await signupsDue(f.env, NOW);
    expect(f.sent()).toHaveLength(SIGNUPS_LIMIT);
  });

  for (const v of [undefined, "", "false", "TRUE"])
    it(`SIGNUPS_ENABLED ${JSON.stringify(v)}: off, nothing read or sent`, async () => {
      await selfServe({ status: "pending", updated_at: 1 });
      const f = fakes({ SIGNUPS_ENABLED: v, SIGNUPS: undefined });
      await signupsDue(f.env, NOW);
      expect(f.sent()).toEqual([]);
    });

  for (const v of SIGNUPS_ON)
    it(`SIGNUPS_ENABLED ${v}: on`, async () => {
      await selfServe({ status: "pending", updated_at: 1 });
      const f = fakes({ SIGNUPS_ENABLED: v });
      captureLogs(vi.spyOn);
      await signupsDue(f.env, NOW);
      expect(f.sent()).toHaveLength(1);
    });

  it("on but no SIGNUPS producer: the duty fails unbound", async () => {
    const f = fakes({ SIGNUPS: undefined });
    await expect(signupsDue(f.env, NOW)).rejects.toEqual(
      new DutyFailure("unbound"),
    );
  });

  it("a failed send is rpc_error, never the error text", async () => {
    await selfServe({ status: "pending", updated_at: 1 });
    const q = {
      sendBatch: async () => {
        throw new Error("queue down owner@customer.test");
      },
    } as unknown as Queue<{ signupId: string }>;
    const f = fakes({ SIGNUPS: q });
    await expect(signupsDue(f.env, NOW)).rejects.toEqual(
      new DutyFailure("rpc_error"),
    );
  });
});
