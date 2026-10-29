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
import billing, { type Env, MAX_CREATORS, TRIAL_MS } from "../src/index.js";

// The tier store's routes. Gate routes answer only over a binding (no
// cf-connecting-ip) and only for the install in x-oa-gate-install; every
// case also checks no other install's row is read or written.

const db = (testEnv as unknown as { BILLING_DB: D1Database }).BILLING_DB;
const env = { BILLING_DB: db } as Env;

beforeAll(async () => {
  const m = (testEnv as unknown as { TEST_MIGRATIONS: D1Migration[] })
    .TEST_MIGRATIONS;
  await applyD1Migrations(db, m);
});

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM tiers"),
    db.prepare("DELETE FROM usage"),
    db.prepare("DELETE FROM stripe_events"),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const A = "iabc123def45";
const B = "izzz999yyy88";
const NOW = Date.UTC(2026, 9, 29, 12, 0);
const ORIGIN = "https://billing.oa.internal";

type Row = {
  install: string;
  tier?: string;
  status?: string;
  trialEndsAt?: number | null;
  version?: number;
};

async function seed(rows: Row[]) {
  await db.batch(
    rows.map((r) =>
      db
        .prepare(
          `INSERT INTO tiers (install_id, tier, status, trial_ends_at, stripe_customer_id, stripe_subscription_id, version, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)`,
        )
        .bind(
          r.install,
          r.tier ?? "free",
          r.status ?? "active",
          r.trialEndsAt ?? null,
          `cus_${r.install}`,
          `sub_${r.install}`,
          r.version ?? 1,
        ),
    ),
  );
}

const rowOf = (install: string) =>
  db.prepare("SELECT * FROM tiers WHERE install_id = ?1").bind(install).first();
const usageOf = (install: string) =>
  db
    .prepare("SELECT * FROM usage WHERE install_id = ?1 ORDER BY month")
    .bind(install)
    .all()
    .then((r) => r.results);

/** A request as the gate sends it: the install header, no cf-connecting-ip. */
function gated(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = { "x-oa-gate-install": A },
) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined
      ? {}
      : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

const call = (req: Request) =>
  billing.fetch(req as Parameters<typeof billing.fetch>[0], env);

const at = () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
};

describe("gate routes answer only over a binding", () => {
  it("any request with cf-connecting-ip gets the plain 404, and reads or writes nothing", async () => {
    await seed([{ install: A }]);
    const before = await rowOf(A);
    for (const [m, p, b] of [
      ["GET", "/tier", undefined],
      ["GET", "/health", undefined],
      ["POST", "/trial/start", { install: A }],
      [
        "POST",
        "/usage",
        { install: A, month: "2026-10", creators: [], count: 0 },
      ],
    ] as [string, string, unknown][]) {
      const r = await call(
        gated(m, p, b, {
          "x-oa-gate-install": A,
          "cf-connecting-ip": "1.2.3.4",
        }),
      );
      expect(r.status).toBe(404);
      expect(await r.text()).toBe("Not found");
    }
    expect(await rowOf(A)).toEqual(before);
    expect(await usageOf(A)).toEqual([]);
  });

  it("/health over a binding is ok, with or without an install header", async () => {
    for (const h of [{}, { "x-oa-gate-install": A }] as Record<
      string,
      string
    >[]) {
      const r = await call(gated("GET", "/health", undefined, h));
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true });
    }
  });

  it("the Stripe webhook is public and not implemented yet", async () => {
    for (const h of [{ "cf-connecting-ip": "1.2.3.4" }, {}] as Record<
      string,
      string
    >[]) {
      const r = await call(
        gated("POST", "/stripe/webhook", { id: "evt_1" }, h),
      );
      expect(r.status).toBe(501);
      expect(await r.json()).toEqual({ error: "not_implemented" });
    }
    expect(
      (await db.prepare("SELECT COUNT(*) AS n FROM stripe_events").first())?.n,
    ).toBe(0);
  });

  it("every other method or path is the plain 404", async () => {
    for (const [m, p] of [
      ["GET", "/"],
      ["GET", "/stripe/webhook"],
      ["POST", "/tier"],
      ["GET", "/trial/start"],
      ["GET", "/usage"],
      ["PUT", "/usage"],
      ["GET", "/tier/"],
      ["GET", "/Tier"],
      ["DELETE", "/tier"],
    ]) {
      const r = await call(gated(m as string, p as string));
      expect(r.status).toBe(404);
      expect(await r.text()).toBe("Not found");
    }
  });
});

describe("the install id comes only from x-oa-gate-install", () => {
  it("no header or a malformed one is the plain 404", async () => {
    await seed([{ install: A }]);
    for (const h of [
      {},
      { "x-oa-gate-install": "" },
      { "x-oa-gate-install": A.toUpperCase() },
      { "x-oa-gate-install": `${A}x` },
      { "x-oa-gate-install": "../iabc123def4" },
    ] as Record<string, string>[]) {
      const r = await call(gated("GET", "/tier", undefined, h));
      expect(r.status).toBe(404);
    }
    expect((await rowOf(A))?.last_read_at).toBeNull();
  });

  it("a query or body naming another install never moves the read or write", async () => {
    at();
    await seed([{ install: A }, { install: B, tier: "team" }]);
    const r = await call(
      new Request(`${ORIGIN}/tier?install=${B}&install_id=${B}`, {
        headers: { "x-oa-gate-install": A },
      }),
    );
    expect(((await r.json()) as { tier: string }).tier).toBe("free");
    expect((await rowOf(A))?.last_read_at).toBe(NOW);
    expect((await rowOf(B))?.last_read_at).toBeNull();

    // A body naming B is refused, and B is untouched.
    const t = await call(gated("POST", "/trial/start", { install: B }));
    expect(t.status).toBe(403);
    const u = await call(
      gated("POST", "/usage", {
        install: B,
        month: "2026-10",
        creators: ["c1"],
        count: 1,
      }),
    );
    expect(u.status).toBe(403);
    expect(await rowOf(B)).toMatchObject({ tier: "team", version: 1 });
    expect(await usageOf(B)).toEqual([]);
    expect(await usageOf(A)).toEqual([]);
  });
});

describe("GET /tier", () => {
  it("returns the install's own row without Stripe ids, and records last_read_at", async () => {
    at();
    await seed([
      { install: A, tier: "trial", trialEndsAt: NOW + 5, version: 3 },
      { install: B, tier: "business" },
    ]);
    const r = await call(gated("GET", "/tier"));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toEqual({
      tier: "trial",
      status: "active",
      trialEndsAt: NOW + 5,
      graceUntil: null,
      version: 3,
      asOf: NOW,
    });
    expect(JSON.stringify(body)).not.toMatch(/cus_|sub_/);
    expect(await rowOf(A)).toMatchObject({ last_read_at: NOW, version: 3 });
    expect((await rowOf(B))?.last_read_at).toBeNull();
  });

  it("a missing row is free/active at version 0, and nothing is written", async () => {
    at();
    const r = await call(gated("GET", "/tier"));
    expect(await r.json()).toEqual({
      tier: "free",
      status: "active",
      trialEndsAt: null,
      graceUntil: null,
      version: 0,
      asOf: NOW,
    });
    expect(
      (await db.prepare("SELECT COUNT(*) AS n FROM tiers").first())?.n,
    ).toBe(0);
  });
});

describe("POST /trial/start", () => {
  it("from free/active: trial for 14 days, version + 1; a second call changes nothing", async () => {
    at();
    await seed([{ install: A, version: 4 }, { install: B }]);
    const r = await call(gated("POST", "/trial/start", { install: A }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      tier: "trial",
      status: "active",
      trialEndsAt: NOW + TRIAL_MS,
      graceUntil: null,
      version: 5,
      asOf: NOW,
    });
    expect(TRIAL_MS).toBe(14 * 86_400_000);
    vi.setSystemTime(NOW + 1000);
    const again = await call(gated("POST", "/trial/start", { install: A }));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({
      tier: "trial",
      trialEndsAt: NOW + TRIAL_MS,
      version: 5,
    });
    expect(await rowOf(B)).toMatchObject({ tier: "free", version: 1 });
  });

  it("never twice: back on free after a trial, it doesn't start again", async () => {
    await seed([
      { install: A, tier: "free", trialEndsAt: NOW - 1, version: 7 },
    ]);
    const r = await call(gated("POST", "/trial/start", { install: A }));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      tier: "free",
      version: 7,
      trialEndsAt: NOW - 1,
    });
  });

  it("any other state: 200 with the unchanged row", async () => {
    for (const [tier, status] of [
      ["team", "active"],
      ["business", "past_due"],
      ["free", "lapsed"],
      ["free", "suspended"],
      ["trial", "active"],
    ]) {
      await db.prepare("DELETE FROM tiers").run();
      await seed([{ install: A, tier, status, version: 2 }]);
      const before = await rowOf(A);
      const r = await call(gated("POST", "/trial/start", { install: A }));
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ tier, status, version: 2 });
      expect(await rowOf(A)).toEqual(before);
    }
  });

  it("no row (the free/active default): the trial starts and the row is created, once", async () => {
    at();
    const r = await call(gated("POST", "/trial/start", { install: A }));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      tier: "trial",
      status: "active",
      trialEndsAt: NOW + TRIAL_MS,
      version: 1,
    });
    expect(await rowOf(A)).toMatchObject({ tier: "trial", version: 1 });
    const again = await call(gated("POST", "/trial/start", { install: A }));
    expect(await again.json()).toMatchObject({ tier: "trial", version: 1 });
    expect(await rowOf(B)).toBeNull();
  });

  it("concurrent starts bump the version once", async () => {
    await seed([{ install: A }]);
    await Promise.all(
      Array.from({ length: 5 }, () =>
        call(gated("POST", "/trial/start", { install: A })),
      ),
    );
    expect(await rowOf(A)).toMatchObject({ tier: "trial", version: 2 });
  });

  it("a body that isn't a JSON object is 400", async () => {
    await seed([{ install: A }]);
    for (const b of ["", "[]", "null", "{"]) {
      const r = await call(gated("POST", "/trial/start", b));
      expect(r.status).toBe(400);
    }
    expect(await rowOf(A)).toMatchObject({ tier: "free", version: 1 });
  });
});

describe("POST /usage", () => {
  const ok = { install: A, month: "2026-10", creators: ["u1", "u2"], count: 2 };

  it("stores the month's list and count; a second report for the month replaces it", async () => {
    at();
    const r = await call(gated("POST", "/usage", ok));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, month: "2026-10", count: 2 });
    vi.setSystemTime(NOW + 1);
    await call(gated("POST", "/usage", { ...ok, creators: ["u3"], count: 1 }));
    await call(gated("POST", "/usage", { ...ok, month: "2026-11" }));
    expect(await usageOf(A)).toEqual([
      {
        install_id: A,
        month: "2026-10",
        creators_json: '["u3"]',
        count: 1,
        received_at: NOW + 1,
      },
      {
        install_id: A,
        month: "2026-11",
        creators_json: '["u1","u2"]',
        count: 2,
        received_at: NOW + 1,
      },
    ]);
    expect(await usageOf(B)).toEqual([]);
  });

  it("the install comes from the header even when the body omits it", async () => {
    const { install: _, ...rest } = ok;
    expect((await call(gated("POST", "/usage", rest))).status).toBe(200);
    expect((await usageOf(A)).length).toBe(1);
  });

  it("accepts MAX_CREATORS, refuses one more", async () => {
    const many = Array.from({ length: MAX_CREATORS + 1 }, (_, i) => `c${i}`);
    const fits = many.slice(0, MAX_CREATORS);
    expect(
      (
        await call(
          gated("POST", "/usage", {
            ...ok,
            creators: fits,
            count: fits.length,
          }),
        )
      ).status,
    ).toBe(200);
    const r = await call(
      gated("POST", "/usage", {
        ...ok,
        month: "2026-09",
        creators: many,
        count: many.length,
      }),
    );
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "bad_creators" });
  });

  it("refuses a bad month, bad creators or a count that isn't the list's length", async () => {
    const cases: [unknown, string][] = [
      [{ ...ok, month: "2026-13" }, "bad_month"],
      [{ ...ok, month: "2026-1" }, "bad_month"],
      [{ ...ok, month: 202610 }, "bad_month"],
      [{ ...ok, month: undefined }, "bad_month"],
      [{ ...ok, creators: "u1" }, "bad_creators"],
      [{ ...ok, creators: ["u1", 2], count: 2 }, "bad_creators"],
      [{ ...ok, creators: ["u1", "u1"], count: 2 }, "bad_creators"],
      [{ ...ok, creators: ["a b"], count: 1 }, "bad_creators"],
      [{ ...ok, creators: [""], count: 1 }, "bad_creators"],
      [{ ...ok, count: 3 }, "bad_count"],
      [{ ...ok, count: "2" }, "bad_count"],
      [{ ...ok, count: undefined }, "bad_count"],
    ];
    for (const [body, error] of cases) {
      const r = await call(gated("POST", "/usage", body));
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error });
    }
    const text = await call(
      new Request(`${ORIGIN}/usage`, {
        method: "POST",
        headers: { "x-oa-gate-install": A, "content-type": "text/plain" },
        body: JSON.stringify(ok),
      }),
    );
    expect(text.status).toBe(400);
    expect(await usageOf(A)).toEqual([]);
  });
});

describe("logs", () => {
  it("carry fixed categories and the install id only: no body, header or URL", async () => {
    await seed([{ install: A }]);
    const lines: string[] = [];
    for (const k of ["log", "warn", "error"] as const)
      vi.spyOn(console, k).mockImplementation((...a: unknown[]) => {
        lines.push(a.map(String).join(" "));
      });
    await call(gated("GET", "/tier"));
    await call(gated("POST", "/trial/start", { install: A, secret: "s3cret" }));
    await call(
      gated("POST", "/usage", {
        install: A,
        month: "2026-10",
        creators: ["creator-x"],
        count: 1,
      }),
    );
    expect(lines).toEqual([
      `billing tier row ${A}`,
      `billing trial started ${A}`,
      `billing usage ${A}`,
    ]);
  });

  it("a D1 error is a 503 with a fixed line", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    const broken = {
      BILLING_DB: {
        prepare: () => {
          throw new Error("D1_ERROR: secret detail");
        },
      },
    } as unknown as Env;
    const r = await billing.fetch(
      gated("GET", "/tier") as Parameters<typeof billing.fetch>[0],
      broken,
    );
    expect(r.status).toBe(503);
    expect(lines).toEqual([`billing db_error ${A}`]);
  });
});
