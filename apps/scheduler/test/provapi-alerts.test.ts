import {
  ALERT_KEYS,
  type AlertRow,
  SIGNIN_BURST_WINDOW_MS,
} from "@oa/shared/provisioning";
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
  ALERT_POLICY,
  ALERT_REMIND_MS,
  ALERT_SEND_TIMEOUT_MS,
  alertFor,
  BURST_EMAIL_INTERVAL_MS,
  factsOf,
  IDS_SHOWN,
  stepAlert,
} from "../src/provapi/alerts.js";
import type { ProvapiEnv } from "../src/provapi/env.js";
import { alertsTick } from "../src/provapi/index.js";
import {
  captureLogs,
  db,
  insert,
  jobId,
  migrate,
  reset,
} from "./provapi/db.js";

// The alert machine (ported from #859's alerts.test.ts): open, no repeat,
// the reminder, clear, a failed send retried, no destination, and the burst
// key's one email per hour across reopens. Every clock is pinned (each step
// takes `now`).

beforeAll(migrate);
beforeEach(reset);
afterEach(() => vi.restoreAllMocks());

const T0 = Date.UTC(2026, 9, 29, 12, 0);
const TICK = 2 * 60_000;
const H = 60 * 60_000;
const DAY = ALERT_REMIND_MS;
const TO = "ops@example.test";
const FROM = "alerts@example.test";
const KEY = "job_failed" as const;
const ALERT = alertFor(KEY, "staging");

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
    env: (o: Partial<ProvapiEnv> = {}): ProvapiEnv =>
      ({
        PLATFORM_DB: db,
        OA_ENV: "staging",
        ALERT_EMAIL: binding,
        ALERT_TO: TO,
        ALERT_FROM: FROM,
        ...o,
      }) as ProvapiEnv,
    set: (m: Mode) => {
      mode = m;
    },
    sent,
    subjects: () => sent.map((s) => s.subject),
  };
}

const state = async (suffix: string, key: string = KEY) =>
  (
    await db
      .prepare("SELECT value FROM platform_state WHERE key = ?1")
      .bind(`${key}_${suffix}`)
      .first<{ value: number }>()
  )?.value ?? null;

const OPEN = "Open Artifacts staging: jobs failed";
const REMIND = "Open Artifacts staging: still open, jobs failed";
const CLEAR = "Open Artifacts staging: cleared, jobs failed";
const P = "provapi alert";

describe("stepAlert", () => {
  it("opens: one email to ALERT_TO from ALERT_FROM, one log line per change", async () => {
    const m = mail();
    const lines = captureLogs(vi.spyOn);
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
    expect(lines).toEqual([`${P} ${KEY} opened`, `${P} ${KEY} sent open`]);
  });

  it("no repeat before the reminder is due, whether the condition holds or is unknown", async () => {
    const m = mail();
    await stepAlert(m.env(), ALERT, true, T0);
    for (const t of [T0 + TICK, T0 + H, T0 + DAY - 1]) {
      await stepAlert(m.env(), ALERT, true, t);
      await stepAlert(m.env(), ALERT, null, t);
    }
    expect(m.subjects()).toEqual([OPEN]);
    expect(await state("opened_at")).toBe(T0);
  });

  it("reminds once per ALERT_REMIND_MS while open, from the last email", async () => {
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

  it("clears: one email and the open row is gone; another clear is quiet; a reopen sends a fresh open", async () => {
    const m = mail();
    const lines = captureLogs(vi.spyOn);
    await stepAlert(m.env(), ALERT, true, T0);
    await stepAlert(m.env(), ALERT, false, T0 + H);
    await stepAlert(m.env(), ALERT, false, T0 + 2 * H);
    expect(m.subjects()).toEqual([OPEN, CLEAR]);
    expect(m.sent[1]?.text).toContain(new Date(T0 + H).toISOString());
    expect(await state("opened_at")).toBeNull();
    expect(await state("cleared_at")).toBeNull();
    expect(lines).toEqual([
      `${P} ${KEY} opened`,
      `${P} ${KEY} sent open`,
      `${P} ${KEY} cleared`,
      `${P} ${KEY} sent clear`,
    ]);
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

  it("a failed open email gives its claim back: logged by category, retried next tick", async () => {
    const m = mail();
    const lines = captureLogs(vi.spyOn);
    m.set("fail");
    await stepAlert(m.env(), ALERT, true, T0);
    expect(await state("notified_at")).toBeNull();
    m.set("ok");
    await stepAlert(m.env(), ALERT, null, T0 + TICK);
    expect(m.subjects()).toEqual([OPEN]);
    expect(lines).toEqual([
      `${P} ${KEY} opened`,
      `${P} ${KEY} send_failed E_RATE_LIMIT`,
      `${P} ${KEY} sent open`,
    ]);
    expect(lines.join("\n")).not.toContain(TO);
  });

  it("a failed reminder gives its claim back and is retried next tick", async () => {
    const m = mail();
    await stepAlert(m.env(), ALERT, true, T0);
    m.set("fail");
    await stepAlert(m.env(), ALERT, true, T0 + DAY);
    expect(await state("notified_at")).toBe(T0);
    m.set("ok");
    await stepAlert(m.env(), ALERT, null, T0 + DAY + TICK);
    expect(m.subjects()).toEqual([OPEN, REMIND]);
    expect(await state("notified_at")).toBe(T0 + DAY + TICK);
  });

  it("a failed clear email is retried on the next tick", async () => {
    const m = mail();
    await stepAlert(m.env(), ALERT, true, T0);
    m.set("fail");
    await stepAlert(m.env(), ALERT, false, T0 + H);
    expect(await state("cleared_at")).toBe(T0 + H);
    m.set("ok");
    await stepAlert(m.env(), ALERT, null, T0 + H + TICK);
    expect(m.subjects()).toEqual([OPEN, CLEAR]);
    expect(await state("cleared_at")).toBeNull();
  });

  it("a send that never settles times out, and is retried", async () => {
    const m = mail();
    const lines = captureLogs(vi.spyOn);
    m.set("hang");
    await stepAlert(m.env(), ALERT, true, T0, { timeoutMs: 10 });
    expect(lines).toContain(`${P} ${KEY} send_failed timeout`);
    expect(await state("notified_at")).toBeNull();
    expect(ALERT_SEND_TIMEOUT_MS).toBe(5_000);
  });

  it("no destination: logged each tick, nothing claimed, so no clear is owed", async () => {
    for (const o of [
      { ALERT_TO: "" },
      { ALERT_TO: undefined },
      { ALERT_TO: "{{OPS_ALERT_EMAIL_STAGING}}" },
      { ALERT_TO: "a@b.test, c@d.test" },
      { ALERT_FROM: "" },
      { ALERT_EMAIL: undefined },
    ] as Partial<ProvapiEnv>[]) {
      await reset();
      const m = mail();
      const lines = captureLogs(vi.spyOn);
      await stepAlert(m.env(o), ALERT, true, T0);
      await stepAlert(m.env(o), ALERT, null, T0 + H);
      await stepAlert(m.env(o), ALERT, null, T0 + DAY);
      await stepAlert(m.env(o), ALERT, false, T0 + DAY + H);
      expect(m.sent).toEqual([]);
      expect(lines).toEqual([
        `${P} ${KEY} opened`,
        `${P} ${KEY} skipped no_destination`,
        `${P} ${KEY} skipped no_destination`,
        `${P} ${KEY} skipped no_destination`,
        `${P} ${KEY} cleared`,
      ]);
      expect(await state("opened_at")).toBeNull();
      expect(await state("notified_at")).toBeNull();
      expect(await state("cleared_at")).toBeNull();
      vi.restoreAllMocks();
    }
  });

  it("an alert that opened before the destination was set emails once it is", async () => {
    const m = mail();
    captureLogs(vi.spyOn);
    await stepAlert(m.env({ ALERT_TO: undefined }), ALERT, true, T0);
    await stepAlert(m.env({ ALERT_TO: undefined }), ALERT, true, T0 + TICK);
    expect(m.sent).toEqual([]);
    await stepAlert(m.env(), ALERT, true, T0 + 2 * TICK);
    await stepAlert(m.env(), ALERT, true, T0 + 3 * TICK);
    expect(m.subjects()).toEqual([OPEN]);
    expect(await state("notified_at")).toBe(T0 + 2 * TICK);
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
    const lines = captureLogs(vi.spyOn);
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
      `${P} ${KEY} db_error`,
      `${P} ${KEY} db_error`,
      `${P} ${KEY} db_error`,
    ]);
    expect(m.sent).toEqual([]);
  });
});

describe("signin_refused_burst: at most one email per hour, count and window only", () => {
  const B = "signin_refused_burst" as const;
  const BURST = alertFor(B, "prod");

  it("the policy is one email per hour, no reminder, no clear email", () => {
    expect(BURST_EMAIL_INTERVAL_MS).toBe(60 * 60_000);
    expect(ALERT_POLICY[B]).toEqual({
      minIntervalMs: BURST_EMAIL_INTERVAL_MS,
      remindMs: null,
      clearEmail: false,
    });
  });

  it("reopens inside the hour send nothing; the first tick past it sends one", async () => {
    const m = mail();
    // A burst lasts one refusal window; it then clears and reopens every
    // window, ticking every 2 minutes.
    const ticks = Math.ceil((3 * BURST_EMAIL_INTERVAL_MS) / TICK);
    const window = SIGNIN_BURST_WINDOW_MS / TICK;
    const sentAt: number[] = [];
    for (let i = 0; i <= ticks; i++) {
      const t = T0 + i * TICK;
      const before = m.sent.length;
      await stepAlert(m.env(), BURST, Math.floor(i / window) % 2 === 0, t);
      if (m.sent.length > before) sentAt.push(t);
    }
    expect(sentAt.length).toBeGreaterThan(1);
    expect(sentAt[0]).toBe(T0);
    for (let i = 1; i < sentAt.length; i++)
      expect(
        (sentAt[i] as number) - (sentAt[i - 1] as number),
      ).toBeGreaterThanOrEqual(BURST_EMAIL_INTERVAL_MS);
    expect(new Set(m.subjects())).toEqual(new Set([BURST.subject.open]));
    expect(await state("notified_at", B)).toBe(sentAt.at(-1));
  });

  it("a burst open across the hour never reminds", async () => {
    const m = mail();
    for (let t = T0; t <= T0 + 3 * BURST_EMAIL_INTERVAL_MS; t += TICK)
      await stepAlert(m.env(), BURST, true, t);
    expect(m.subjects()).toEqual([BURST.subject.open]);
  });

  it("the text names the count threshold and the window, nothing else", () => {
    const text = BURST.text("open", T0);
    expect(text).toContain(`${SIGNIN_BURST_WINDOW_MS / 60_000} minutes`);
    expect(text).not.toMatch(/\n[a-z0-9]{12}\n/);
  });
});

describe("email text", () => {
  const MESSAGE = "boom owner@customer.test https://x.test — secret";
  const rows: AlertRow[] = Array.from({ length: IDS_SHOWN + 3 }, (_, i) => ({
    install_id: `i${String(i).padStart(11, "0")}`,
    job_id: jobId(1000 + i),
    job_kind: i === 0 ? "not a kind" : "create",
    code: i === 1 ? "Bad Code owner@customer.test" : "cf_error",
    message: MESSAGE,
    since: T0,
  }));

  it("facts keep valid ids and enum codes only, never the message", () => {
    const f = factsOf(rows);
    expect(f.count).toBe(rows.length);
    expect(f.installIds).toHaveLength(rows.length);
    expect(f.jobs[0]?.kind).toBeNull();
    expect(f.jobs[1]?.code).toBe("other");
    expect(JSON.stringify(f)).not.toContain("owner@");
    const bad = factsOf([
      { ...rows[0], install_id: "x@y", job_id: "nope" } as AlertRow,
    ]);
    expect(bad.installIds).toEqual([]);
    expect(bad.jobs).toEqual([]);
  });

  it("every key, every state: no '@', no em dash, no URL, no message; three subjects", () => {
    for (const k of ALERT_KEYS) {
      const a = alertFor(k, "prod", { ...factsOf(rows), daysLeft: 12 });
      expect(new Set(Object.values(a.subject)).size, k).toBe(3);
      for (const s of ["open", "remind", "clear"] as const) {
        const all = `${a.subject[s]}\n${a.text(s, T0)}`;
        expect(all, `${k} ${s}`).not.toMatch(/@|—|https?:|www\.|\{\{/);
        expect(all).not.toContain("boom");
        expect(a.subject[s]).toMatch(/^Open Artifacts prod: /);
      }
    }
  });

  it("lists at most IDS_SHOWN ids, then a count of the rest", () => {
    const text = alertFor(KEY, "prod", factsOf(rows)).text("open", T0);
    expect(text).toContain("and 3 more");
    expect(text.split("\n").filter((l) => l.startsWith("i0"))).toHaveLength(
      IDS_SHOWN,
    );
  });
});

describe("prodclean_failed", () => {
  it("the email carries the latest report's install id and detail, sanitized", async () => {
    const m = mail();
    captureLogs(vi.spyOn);
    await insert("prodclean_reports", {
      at: T0 - H,
      ok: 0,
      code: "dirty",
      install_id: "i00000000077",
      detail: "older",
    });
    await insert("prodclean_reports", {
      at: T0,
      ok: 0,
      code: "dirty",
      install_id: "i00000000042",
      detail: `binding KV_EXTRA on owner@customer.test, see https://x.test/a\u0007\n${"y".repeat(1000)}`,
    });
    await alertsTick(m.env(), T0);
    const open = m.sent.filter((x) => x.subject.includes("prod-clean"));
    expect(open).toHaveLength(1);
    const text = open[0]?.text ?? "";
    expect(text).toContain("i00000000042");
    expect(text).not.toContain("i00000000077");
    expect(text).toContain("binding KV_EXTRA on owner");
    expect(text).not.toMatch(/@|:\/\/|\u2014/);
    expect(text).not.toContain(String.fromCharCode(7));
    expect(text.length).toBeLessThan(1000);
  });

  it("a report with a malformed install id leaves it out", async () => {
    const m = mail();
    captureLogs(vi.spyOn);
    await insert("prodclean_reports", {
      at: T0,
      ok: 0,
      code: "dirty",
      install_id: "owner@customer.test",
      detail: null,
    });
    await alertsTick(m.env(), T0);
    const text = m.sent.find((x) => x.subject.includes("prod-clean"))?.text;
    expect(text).toBeDefined();
    expect(text).not.toContain("customer");
  });
});
