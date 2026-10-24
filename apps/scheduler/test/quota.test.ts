import { afterEach, describe, expect, it, vi } from "vitest";
import { emailQuota } from "../src/quota.js";

// Email-quota alert (T7 follow-up): one GraphQL read of Cloudflare's Email
// Sending analytics, never an install's D1. The fetch is a fake global.

const Z1 = "a".repeat(32);
const Z2 = "b".repeat(32);
const TOKEN = "tok_SECRET_0123456789abcdef";
const NOW = Date.UTC(2026, 9, 24, 3, 17);
// The previous UTC day: [2026-10-23T00:00Z, 2026-10-24T00:00Z).
const START = "2026-10-23T00:00:00.000Z";
const END = "2026-10-24T00:00:00.000Z";

type Env = Parameters<typeof emailQuota>[0];
const env = (o: Partial<Env> = {}): Env => ({
  EMAIL_QUOTA_TOKEN: TOKEN,
  EMAIL_QUOTA_ZONES: `${Z1},${Z2}`,
  EMAIL_DAILY_LIMIT: "1000",
  ...o,
});

/** The response for zones, each a list of group counts. */
const body = (zones: number[][]) => ({
  data: {
    viewer: {
      zones: zones.map((cs) => ({
        emailSendingAdaptiveGroups: cs.map((count) => ({ count })),
      })),
    },
  },
  errors: null,
});

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status });

function logs() {
  const lines: { level: string; text: string }[] = [];
  for (const level of ["log", "warn", "error", "info"] as const)
    vi.spyOn(console, level).mockImplementation((...a: unknown[]) => {
      lines.push({ level, text: a.map(String).join(" ") });
    });
  return lines;
}

/** The whole quota log vocabulary. */
const QUOTA_LINE =
  /^email-quota (?:skipped (?:no_token|config)|failed (?:http|graphql|timeout|shape)|(?:ok|warn) sent=\d+ limit=\d+ pct=\d+)$/;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const stub = (impl: (...a: unknown[]) => unknown) => {
  const f = vi.fn(impl);
  vi.stubGlobal("fetch", f);
  return f;
};

describe("emailQuota", () => {
  it("no token: no call, one skip line", async () => {
    const f = stub(() => json(body([[1]])));
    const l = logs();
    await emailQuota(env({ EMAIL_QUOTA_TOKEN: undefined }), NOW);
    await emailQuota(env({ EMAIL_QUOTA_TOKEN: "" }), NOW);
    expect(f).not.toHaveBeenCalled();
    expect(l.map((x) => x.text)).toEqual([
      "email-quota skipped no_token",
      "email-quota skipped no_token",
    ]);
  });

  it.each([
    ["no zones", { EMAIL_QUOTA_ZONES: undefined }],
    ["empty zones", { EMAIL_QUOTA_ZONES: " , " }],
    [
      "unfilled placeholder",
      { EMAIL_QUOTA_ZONES: "{{EMAIL_ZONE_TAG_STAGING}}" },
    ],
    ["not a zone tag", { EMAIL_QUOTA_ZONES: `${Z1},nope` }],
    [
      "over 10 zones",
      {
        EMAIL_QUOTA_ZONES: Array.from({ length: 11 }, (_, i) =>
          i.toString(16).padStart(32, "0"),
        ).join(","),
      },
    ],
    ["no limit", { EMAIL_DAILY_LIMIT: undefined }],
    ["placeholder limit", { EMAIL_DAILY_LIMIT: "{{EMAIL_DAILY_LIMIT}}" }],
    ["zero limit", { EMAIL_DAILY_LIMIT: "0" }],
    ["negative limit", { EMAIL_DAILY_LIMIT: "-5" }],
    ["fractional limit", { EMAIL_DAILY_LIMIT: "10.5" }],
    ["exponent limit", { EMAIL_DAILY_LIMIT: "1e3" }],
    ["leading zero limit", { EMAIL_DAILY_LIMIT: "010" }],
    ["padded limit", { EMAIL_DAILY_LIMIT: " 5" }],
    ["limit past 9 digits", { EMAIL_DAILY_LIMIT: "1234567890" }],
  ])("bad config (%s): no call, config skip line", async (_n, o) => {
    const f = stub(() => json(body([[1]])));
    const l = logs();
    await emailQuota(env(o as Partial<Env>), NOW);
    expect(f).not.toHaveBeenCalled();
    expect(l.map((x) => x.text)).toEqual(["email-quota skipped config"]);
  });

  it("queries the Email Sending dataset for exactly yesterday's UTC window and every zone", async () => {
    const f = stub(() => json(body([[1], [2]])));
    logs();
    await emailQuota(env(), NOW);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.cloudflare.com/client/v4/graphql");
    expect(init.method).toBe("POST");
    const h = new Headers(init.headers);
    expect(h.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(h.get("content-type")).toBe("application/json");
    const b = JSON.parse(init.body as string);
    expect(b.variables).toEqual({
      zoneTags: [Z1, Z2],
      start: START,
      end: END,
    });
    expect(b.query).toContain("emailSendingAdaptiveGroups");
    expect(b.query).toMatch(/datetimeHour_geq:\s*\$start/);
    expect(b.query).toMatch(/datetimeHour_lt:\s*\$end/);
    // Each email once: count is per event, and only the last event of an
    // email has isLastEvent 1. No status filter (all statuses count).
    expect(b.query).toMatch(/isLastEvent:\s*1\b/);
    expect(b.query).not.toMatch(/status/);
    // Nothing secret or per-zone is inlined in the query text.
    expect(b.query).not.toContain(TOKEN);
    expect(b.query).not.toContain(Z1);
  });

  it("the window follows scheduledTime, on a UTC day boundary", async () => {
    const f = stub(() => json(body([[0], [0]])));
    logs();
    await emailQuota(env(), Date.UTC(2027, 0, 1, 0, 0, 0));
    const b = JSON.parse(
      (f.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(b.variables.start).toBe("2026-12-31T00:00:00.000Z");
    expect(b.variables.end).toBe("2027-01-01T00:00:00.000Z");
  });

  it("sums sends across zones and groups", async () => {
    stub(() => json(body([[100, 50], [25]])));
    const l = logs();
    await emailQuota(env({ EMAIL_DAILY_LIMIT: "1000" }), NOW);
    expect(l).toEqual([
      { level: "log", text: "email-quota ok sent=175 limit=1000 pct=17" },
    ]);
  });

  it("79% is ok (log), 80% warns", async () => {
    stub(() => json(body([[790], [0]])));
    let l = logs();
    await emailQuota(env(), NOW);
    expect(l).toEqual([
      { level: "log", text: "email-quota ok sent=790 limit=1000 pct=79" },
    ]);
    vi.restoreAllMocks();
    stub(() => json(body([[800], [0]])));
    l = logs();
    await emailQuota(env(), NOW);
    expect(l).toEqual([
      { level: "warn", text: "email-quota warn sent=800 limit=1000 pct=80" },
    ]);
  });

  it("79.9% is still ok, and over 100% warns", async () => {
    stub(() => json(body([[799], [0]])));
    let l = logs();
    await emailQuota(env(), NOW);
    expect(l[0]?.level).toBe("log");
    vi.restoreAllMocks();
    stub(() => json(body([[1500], [0]])));
    l = logs();
    await emailQuota(env(), NOW);
    expect(l).toEqual([
      { level: "warn", text: "email-quota warn sent=1500 limit=1000 pct=150" },
    ]);
  });

  it("zone tags are deduped and lowercased: one query for one zone", async () => {
    const f = stub(() => json(body([[7]])));
    const l = logs();
    await emailQuota(
      env({ EMAIL_QUOTA_ZONES: `${Z1},${Z1.toUpperCase()}, ${Z1}` }),
      NOW,
    );
    expect(f).toHaveBeenCalledTimes(1);
    const b = JSON.parse(
      (f.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(b.variables.zoneTags).toEqual([Z1]);
    expect(l.map((x) => x.text)).toEqual([
      "email-quota ok sent=7 limit=1000 pct=0",
    ]);
  });

  it("does not follow redirects: a 3xx is http, with the token never re-sent", async () => {
    const f = stub(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.test/x" },
        }),
    );
    const l = logs();
    await emailQuota(env(), NOW);
    expect(f).toHaveBeenCalledTimes(1);
    expect((f.mock.calls[0] as [string, RequestInit])[1].redirect).toBe(
      "manual",
    );
    expect(l).toEqual([{ level: "error", text: "email-quota failed http" }]);
  });

  const failing: [string, () => unknown, string][] = [
    ["http 500", () => json({ errors: [{ message: "x" }] }, 500), "http"],
    ["http 403", () => json(body([[1], [1]]), 403), "http"],
    ["network error", () => Promise.reject(new Error(`dns ${TOKEN}`)), "http"],
    [
      "graphql errors",
      () => json({ ...body([[1], [1]]), errors: [{ message: `bad ${Z1}` }] }),
      "graphql",
    ],
    ["not json", () => new Response("<html>oops</html>"), "shape"],
    ["no data", () => json({}), "shape"],
    ["null data", () => json({ data: null, errors: null }), "shape"],
    [
      "zones not an array",
      () => json({ data: { viewer: { zones: {} } } }),
      "shape",
    ],
    ["a zone is missing", () => json(body([[1]])), "shape"],
    [
      "groups not an array",
      () => json({ data: { viewer: { zones: [{}, {}] } } }),
      "shape",
    ],
    ["negative count", () => json(body([[-1], [1]])), "shape"],
    ["fractional count", () => json(body([[1.5], [1]])), "shape"],
    [
      "string count",
      () =>
        json({
          data: {
            viewer: {
              zones: [
                { emailSendingAdaptiveGroups: [{ count: "9" }] },
                { emailSendingAdaptiveGroups: [] },
              ],
            },
          },
        }),
      "shape",
    ],
  ];
  it.each(failing)("%s -> failed %s only", async (_n, impl, cat) => {
    stub(impl);
    const l = logs();
    await emailQuota(env(), NOW);
    expect(l).toEqual([{ level: "error", text: `email-quota failed ${cat}` }]);
  });

  it("a hanging fetch that ignores abort times out for real", async () => {
    stub(() => new Promise(() => {}));
    const l = logs();
    const t0 = Date.now();
    await emailQuota(env(), NOW, { timeoutMs: 40 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(l).toEqual([{ level: "error", text: "email-quota failed timeout" }]);
  });

  it("a body that stalls after the headers times out too, and abort is signaled", async () => {
    let signal: AbortSignal | undefined;
    stub((_u, init) => {
      signal = (init as RequestInit).signal as AbortSignal;
      const stalled = new ReadableStream({ start() {} });
      return new Response(stalled, { status: 200 });
    });
    const l = logs();
    await emailQuota(env(), NOW, { timeoutMs: 40 });
    expect(l).toEqual([{ level: "error", text: "email-quota failed timeout" }]);
    expect(signal?.aborted).toBe(true);
  });

  it("the default hard timeout is 10 s", async () => {
    vi.useFakeTimers();
    stub(() => new Promise(() => {}));
    const l = logs();
    const p = emailQuota(env(), NOW);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(l).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(l.map((x) => x.text)).toEqual(["email-quota failed timeout"]);
  });

  it("never logs the token, zone tags, response text, addresses or URLs", async () => {
    const leak = `leak ${TOKEN} ${Z1} ${Z2} owner@customer.test https://api.cloudflare.com/x`;
    const cases: (() => unknown)[] = [
      () => json({ errors: [{ message: leak }] }, 500),
      () => json({ ...body([[1], [1]]), errors: [{ message: leak }] }),
      () => new Response(leak),
      () => Promise.reject(new Error(leak)),
      () => json(body([[1], [1]])),
      () => json(body([[900], [0]])),
    ];
    for (const impl of cases) {
      vi.restoreAllMocks();
      const f = stub(impl);
      const l = logs();
      await emailQuota(env(), NOW);
      await emailQuota(env({ EMAIL_QUOTA_TOKEN: undefined }), NOW);
      await emailQuota(env({ EMAIL_DAILY_LIMIT: "0" }), NOW);
      expect(l.length).toBeGreaterThan(0);
      expect(f).toHaveBeenCalledTimes(1);
      for (const { text } of l) {
        expect(text).toMatch(QUOTA_LINE);
        expect(text).not.toMatch(
          new RegExp(`${TOKEN}|${Z1}|${Z2}|@|https?:|leak|api\\.cloudflare`),
        );
      }
    }
  });

  it("sends the token only to api.cloudflare.com, with the global fetch", async () => {
    const f = stub(() => json(body([[1], [1]])));
    logs();
    await emailQuota(env(), NOW);
    for (const [url, init] of f.mock.calls as [string, RequestInit][]) {
      expect(new URL(url).host).toBe("api.cloudflare.com");
      expect(String(init.body)).not.toContain(TOKEN);
    }
  });
});
