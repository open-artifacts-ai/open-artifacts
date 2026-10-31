import { CfError, ProvisionRefused } from "@oa/provision/jobs";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { DutyFailure } from "../src/provapi/env.js";
import {
  DUTY_NAMES,
  type Duty,
  dutyCategory,
  runDuties,
  SCHEDULER_TICK_KEY,
  writeTick,
} from "../src/provapi/run.js";
import { getState } from "../src/provapi/state.js";
import { captureLogs, db, migrate, reset } from "./provapi/db.js";

beforeAll(migrate);
beforeEach(reset);
afterEach(() => vi.restoreAllMocks());

const NOW = Date.UTC(2026, 9, 31, 12, 0);
const LINE = /^provapi (sweep|purge|health|alerts|prune) failed [a-z_]+$/;

const duty = (name: Duty["name"], run: () => Promise<void>, timeoutMs = 50) => ({
  name,
  run,
  timeoutMs,
});

describe("writeTick", () => {
  it("writes scheduler_tick_at and never lowers it", async () => {
    await writeTick(db, NOW);
    await writeTick(db, NOW - 120_000);
    expect(await getState(db, SCHEDULER_TICK_KEY)).toBe(NOW);
  });
});

describe("runDuties", () => {
  it("one duty throwing or hanging leaves the others running", async () => {
    const lines = captureLogs(vi.spyOn);
    const ran: string[] = [];
    const out = await runDuties([
      duty("sweep", async () => {
        throw new Error("D1_ERROR owner@customer.test SECRET");
      }),
      duty("purge", () => new Promise<void>(() => {})),
      duty("health", () => {
        throw new DutyFailure("db_error");
      }),
      duty("alerts", async () => {
        ran.push("alerts");
      }),
      duty("prune", async () => {
        throw new ProvisionRefused("x owner@customer.test", "lease_held");
      }),
    ]);
    expect(ran).toEqual(["alerts"]);
    expect(out).toEqual({
      sweep: "exception",
      purge: "timeout",
      health: "db_error",
      alerts: "ok",
      prune: "lease_held",
    });
    expect(lines).toEqual([
      "provapi sweep failed exception",
      "provapi purge failed timeout",
      "provapi health failed db_error",
      "provapi prune failed lease_held",
    ]);
    for (const l of lines) expect(l).toMatch(LINE);
  });

  it("categories come from provisionErrorCode or a fixed set, never the text", () => {
    expect(dutyCategory(new CfError("GET", "/x", 500, "owner@x.test"))).toBe(
      "cf_error",
    );
    expect(dutyCategory(new DutyFailure("rpc_error"))).toBe("rpc_error");
    expect(dutyCategory("a string")).toBe("exception");
  });

  it("names every duty", () => {
    expect(DUTY_NAMES).toEqual(["sweep", "purge", "health", "alerts", "prune"]);
  });
});
