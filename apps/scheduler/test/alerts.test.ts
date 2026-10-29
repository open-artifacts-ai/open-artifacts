import { applyD1Migrations } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  ALERT_REMIND_MS,
  ALERT_SEND_TIMEOUT_MS,
  type AlertEnv,
  billingAlert,
  emailQuotaAlert,
  stepAlert,
} from "../src/alerts.js";

// The operator alert state machine: open, no repeat within 24 h, the daily
// reminder, clear, a failed send retried, and no destination. Every clock is
// pinned (each step takes `now`).

const db = (testEnv as unknown as { PLATFORM_DB: D1Database }).PLATFORM_DB;

beforeAll(async () => {
  const m = (testEnv as unknown as { TEST_MIGRATIONS: D1Migration[] })
    .TEST_MIGRATIONS;
  await applyD1Migrations(db, m);
});

beforeEach(async () => {
  await db.prepare("DELETE FROM platform_state").run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const T0 = Date.UTC(2026, 9, 29, 12, 0);
const H = 60 * 60_000;
const DAY = ALERT_REMIND_MS;
const TO = "ops@example.test";
const FROM = "alerts@example.test";
const ALERT = billingAlert("staging");
const KEY = ALERT.key;

type Mode = "ok" | "fail" | "hang";
type Sent = { from: string; to: string; subject: string; text: string };

function mail() {
  let mode: Mode = "ok";
  const sent: Sent[] = [];
  const binding = {
    send: async (m: Sent) => {
      if (mode === "hang") return new Promise(() => {});
      if (mode === "fail")
        throw Object.assign(new Error(`rejected for ${TO}`), {
          code: "E_RATE_LIMIT",
        });
      sent.push(m);
      return { messageId: "m1" };
    },
  } as unknown as SendEmail;
  return {
    env: (o: Partial<AlertEnv> = {}): AlertEnv => ({
      PLATFORM_DB: db,
      ALERT_EMAIL: binding,
      ALERT_TO: TO,
      ALERT_FROM: FROM,
      ...o,
    }),
    set: (m: Mode) => {
      mode = m;
    },
    sent,
    subjects: () => sent.map((s) => s.subject),
  };
}

const state = async (suffix: string) =>
  (
    await db
      .prepare("SELECT value FROM platform_state WHERE key = ?1")
      .bind(`${KEY}_${suffix}`)
      .first<{ value: number }>()
  )?.value ?? null;

function logs() {
  const lines: string[] = [];
  for (const k of ["log", "warn", "error"] as const)
    vi.spyOn(console, k).mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
  return lines;
}

const OPEN = "Open Artifacts staging: billing unreachable";
const REMIND = "Open Artifacts staging: billing still unreachable";
const CLEAR = "Open Artifacts staging: billing reachable again";

describe("stepAlert", () => {
  it("opens: one email to ALERT_TO from ALERT_FROM, one log line per change", async () => {
    const m = mail();
    const lines = logs();
    await stepAlert(m.env(), ALERT, true, T0);
    expect(m.sent).toEqual([
      {
        from: FROM,
        to: TO,
        subject: OPEN,
        text: expect.stringContaining(new Date(T0).toISOString()),
      },
    ]);
    expect(await state("opened_at")).toBe(T0);
    expect(await state("notified_at")).toBe(T0);
    expect(lines).toEqual([`alert ${KEY} opened`, `alert ${KEY} sent open`]);
  });

  it("no repeat within 24 h, whether the condition holds or is unknown", async () => {
    const m = mail();
    await stepAlert(m.env(), ALERT, true, T0);
    for (const t of [T0 + 2 * 60_000, T0 + H, T0 + DAY - 1]) {
      await stepAlert(m.env(), ALERT, true, t);
      await stepAlert(m.env(), ALERT, null, t);
    }
    expect(m.subjects()).toEqual([OPEN]);
    expect(await state("opened_at")).toBe(T0);
  });

  it("reminds once a day while open, from the last email", async () => {
    const m = mail();
    await stepAlert(m.env(), ALERT, true, T0);
    await stepAlert(m.env(), ALERT, true, T0 + DAY);
    await stepAlert(m.env(), ALERT, null, T0 + DAY + H);
    await stepAlert(m.env(), ALERT, null, T0 + 2 * DAY - 1);
    await stepAlert(m.env(), ALERT, null, T0 + 2 * DAY);
    expect(m.subjects()).toEqual([OPEN, REMIND, REMIND]);
    expect(m.sent[1]?.text).toContain(new Date(T0).toISOString());
    expect(await state("notified_at")).toBe(T0 + 2 * DAY);
  });

  it("remind: false never sends a due reminder (the check that may clear it runs later)", async () => {
    const m = mail();
    await stepAlert(m.env(), ALERT, true, T0);
    await stepAlert(m.env(), ALERT, null, T0 + 2 * DAY, { remind: false });
    expect(m.subjects()).toEqual([OPEN]);
  });

  it("clears: one email and the rows are gone; another clear is quiet", async () => {
    const m = mail();
    const lines = logs();
    await stepAlert(m.env(), ALERT, true, T0);
    await stepAlert(m.env(), ALERT, false, T0 + H);
    await stepAlert(m.env(), ALERT, false, T0 + 2 * H);
    expect(m.subjects()).toEqual([OPEN, CLEAR]);
    expect(m.sent[1]?.text).toContain(new Date(T0 + H).toISOString());
    for (const s of ["opened_at", "notified_at", "cleared_at"])
      expect(await state(s)).toBeNull();
    expect(lines).toEqual([
      `alert ${KEY} opened`,
      `alert ${KEY} sent open`,
      `alert ${KEY} cleared`,
      `alert ${KEY} sent clear`,
    ]);
    // Never open: a clear is quiet, and it reopens with a fresh open email.
    await stepAlert(m.env(), ALERT, true, T0 + 3 * H);
    expect(m.subjects()).toEqual([OPEN, CLEAR, OPEN]);
  });

  it("a clear before the open email ever went out sends nothing", async () => {
    const m = mail();
    m.set("fail");
    await stepAlert(m.env(), ALERT, true, T0);
    m.set("ok");
    await stepAlert(m.env(), ALERT, false, T0 + H);
    expect(m.sent).toEqual([]);
    expect(await state("opened_at")).toBeNull();
    expect(await state("cleared_at")).toBeNull();
  });

  it("a failed open email is logged by category and retried on the next tick", async () => {
    const m = mail();
    const lines = logs();
    m.set("fail");
    await stepAlert(m.env(), ALERT, true, T0);
    expect(await state("notified_at")).toBeNull();
    m.set("ok");
    await stepAlert(m.env(), ALERT, null, T0 + 2 * 60_000, { remind: false });
    expect(m.subjects()).toEqual([OPEN]);
    expect(lines).toEqual([
      `alert ${KEY} opened`,
      `alert ${KEY} send_failed E_RATE_LIMIT`,
      `alert ${KEY} sent open`,
    ]);
    expect(lines.join("\n")).not.toContain(TO);
  });

  it("a failed reminder is owed (0) and retried next tick, even with remind: false", async () => {
    const m = mail();
    await stepAlert(m.env(), ALERT, true, T0);
    m.set("fail");
    await stepAlert(m.env(), ALERT, true, T0 + DAY);
    expect(await state("notified_at")).toBe(0);
    m.set("ok");
    await stepAlert(m.env(), ALERT, null, T0 + DAY + 2 * 60_000, {
      remind: false,
    });
    expect(m.subjects()).toEqual([OPEN, REMIND]);
    expect(await state("notified_at")).toBe(T0 + DAY + 2 * 60_000);
  });

  it("a failed clear email is retried on the next tick", async () => {
    const m = mail();
    await stepAlert(m.env(), ALERT, true, T0);
    m.set("fail");
    await stepAlert(m.env(), ALERT, false, T0 + H);
    expect(await state("cleared_at")).toBe(T0 + H);
    m.set("ok");
    await stepAlert(m.env(), ALERT, null, T0 + H + 2 * 60_000);
    expect(m.subjects()).toEqual([OPEN, CLEAR]);
    expect(await state("cleared_at")).toBeNull();
  });

  it("a send that never settles times out, and is retried", async () => {
    const m = mail();
    const lines = logs();
    m.set("hang");
    await stepAlert(m.env(), ALERT, true, T0, { timeoutMs: 10 });
    expect(lines).toContain(`alert ${KEY} send_failed timeout`);
    expect(await state("notified_at")).toBeNull();
    expect(ALERT_SEND_TIMEOUT_MS).toBe(5_000);
  });

  it("no destination: logs `alert skipped no_destination`, and the state machine runs on", async () => {
    for (const o of [
      { ALERT_TO: "" },
      { ALERT_TO: undefined },
      { ALERT_TO: "{{OPS_ALERT_EMAIL_STAGING}}" },
      { ALERT_TO: "a@b.test, c@d.test" },
      { ALERT_FROM: "" },
      { ALERT_EMAIL: undefined },
    ] as Partial<AlertEnv>[]) {
      await db.prepare("DELETE FROM platform_state").run();
      const m = mail();
      const lines = logs();
      await stepAlert(m.env(o), ALERT, true, T0);
      // Not retried every tick, but the reminder is still due a day later.
      await stepAlert(m.env(o), ALERT, null, T0 + H);
      await stepAlert(m.env(o), ALERT, null, T0 + DAY);
      await stepAlert(m.env(o), ALERT, false, T0 + DAY + H);
      expect(m.sent).toEqual([]);
      expect(lines).toEqual([
        `alert ${KEY} opened`,
        "alert skipped no_destination",
        "alert skipped no_destination",
        `alert ${KEY} cleared`,
        "alert skipped no_destination",
      ]);
      for (const s of ["opened_at", "notified_at", "cleared_at"])
        expect(await state(s)).toBeNull();
      vi.restoreAllMocks();
    }
  });

  it("overlapping ticks open, remind and clear once", async () => {
    const m = mail();
    const many = (c: boolean | null, t: number) =>
      Promise.all(
        Array.from({ length: 4 }, () => stepAlert(m.env(), ALERT, c, t)),
      );
    await many(true, T0);
    await many(true, T0 + DAY);
    await many(false, T0 + DAY + H);
    expect(m.subjects()).toEqual([OPEN, REMIND, CLEAR]);
  });

  it("a platform D1 error is one fixed line and never throws", async () => {
    const m = mail();
    const lines = logs();
    const broken = m.env({
      PLATFORM_DB: {
        prepare: () => {
          throw new Error("D1_ERROR: secret detail");
        },
      } as unknown as D1Database,
    });
    for (const c of [true, false, null])
      await expect(stepAlert(broken, ALERT, c, T0)).resolves.toBeUndefined();
    expect(lines).toEqual([
      `alert ${KEY} db_error`,
      `alert ${KEY} db_error`,
      `alert ${KEY} db_error`,
    ]);
    expect(m.sent).toEqual([]);
  });

  it("emails are plain fixed text: no URL, no address, a fixed subject per key and state", async () => {
    for (const a of [billingAlert("prod"), emailQuotaAlert("prod")]) {
      expect(new Set(Object.values(a.subject)).size).toBe(3);
      for (const s of ["open", "remind", "clear"] as const) {
        const text = a.text(s, T0);
        expect(text).not.toMatch(/https?:|www\.|@|\{\{/);
        expect(a.subject[s]).toMatch(/^Open Artifacts prod: /);
      }
    }
    expect(emailQuotaAlert("prod").key).toBe("email_quota");
    expect(billingAlert("prod").key).toBe("billing_unreachable");
  });
});
