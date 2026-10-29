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
import { keyId, publicFromPkcs8, signRequest } from "@oa/auth-core";
import { clearRegistryCache } from "@oa/broker-core";
import billing, { type Env, MAX_CREATORS, TRIAL_MS } from "../src/index.js";

// The tier store's routes. Gate routes answer only over a binding (no
// cf-connecting-ip) and only for the install in x-oa-gate-install; every
// case also checks no other install's row is read or written. The POSTs also
// carry the install's Ed25519 signature (the auth broker's redeem scheme).

const db = (testEnv as unknown as { BILLING_DB: D1Database }).BILLING_DB;
const registry = (testEnv as unknown as { BROKER_REGISTRY: KVNamespace })
  .BROKER_REGISTRY;
const env = { BILLING_DB: db, BROKER_REGISTRY: registry } as Env;

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
  clearRegistryCache();
  await register();
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

/** A PKCS#8 Ed25519 private key from a fixed seed, base64url. */
const pk = (fill: number) =>
  b64u(
    new Uint8Array([
      ...[0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65],
      ...[0x70, 0x04, 0x22, 0x04, 0x20],
      ...new Uint8Array(32).fill(fill),
    ]),
  );
function b64u(bytes: Uint8Array) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const KEYS: Record<string, string> = { [A]: pk(1), [B]: pk(2) };
const kidOf = async (key: string) => keyId(await publicFromPkcs8(key));

/** The registry entries the auth broker reads: A and B, one key each. */
async function register() {
  for (const [id, key] of Object.entries(KEYS)) {
    const x = await publicFromPkcs8(key);
    await registry.put(
      `install:${id}`,
      JSON.stringify({
        installId: id,
        origin: `https://${id}.example.test`,
        keys: [{ kid: await keyId(x), x }],
      }),
    );
  }
}

type Sign = {
  /** The key to sign with (default: the header install's). */
  key?: string;
  /** The path the signature covers (default: the request's). */
  path?: string;
  /** Sign this text instead of the body sent. */
  text?: string;
  /** Leave the request unsigned. */
  none?: boolean;
};

/**
 * A request as the gate sends it: the install header, no cf-connecting-ip.
 * A POST is signed as an install signs it: its object body gets `ts` (now)
 * unless it has one, and x-oa-kid/x-oa-sig cover the path and exact text.
 */
async function gated(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = { "x-oa-gate-install": A },
  sign: Sign = {},
) {
  const text =
    body === undefined
      ? undefined
      : typeof body === "string"
        ? body
        : JSON.stringify(
            typeof body === "object" && body !== null && !("ts" in body)
              ? { ...body, ts: Date.now() }
              : body,
          );
  const install = headers["x-oa-gate-install"] ?? A;
  const key = sign.key ?? KEYS[install] ?? KEYS[A];
  const sig: Record<string, string> =
    method === "POST" && text !== undefined && !sign.none && key
      ? {
          "x-oa-kid": await kidOf(key),
          "x-oa-sig": await signRequest(
            key,
            sign.path ?? path,
            await kidOf(key),
            sign.text ?? text,
          ),
        }
      : {};
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...sig,
      ...headers,
    },
    ...(text === undefined ? {} : { body: text }),
  });
}

const call = async (req: Request | Promise<Request>) =>
  billing.fetch((await req) as Parameters<typeof billing.fetch>[0], env);

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

describe("the POSTs carry the gate install's signature", () => {
  const usage = { month: "2026-10", creators: ["u1"], count: 1 };
  const POSTS: [string, Record<string, unknown>][] = [
    ["/trial/start", { install: A }],
    ["/usage", { install: A, ...usage }],
  ];

  /** Nothing was written for A or B, and B's row is as seeded. */
  async function nothingWritten() {
    expect(await rowOf(A)).toMatchObject({ tier: "free", version: 1 });
    expect(await rowOf(B)).toMatchObject({ tier: "team", version: 1 });
    expect(await usageOf(A)).toEqual([]);
    expect(await usageOf(B)).toEqual([]);
  }

  async function refused(req: Request | Promise<Request>) {
    const r = await call(req);
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: "bad_signature" });
  }

  beforeEach(async () => {
    await seed([{ install: A }, { install: B, tier: "team" }]);
  });

  it("a signed POST passes (the baseline for every refusal below)", async () => {
    at();
    expect((await call(gated("POST", "/trial/start", { install: A }))).status)
      .toBe(200);
    expect(
      (await call(gated("POST", "/usage", { install: A, ...usage }))).status,
    ).toBe(200);
    expect(await rowOf(A)).toMatchObject({ tier: "trial", version: 2 });
    expect(await usageOf(A)).toHaveLength(1);
  });

  it("no signature, or only half of one: 401, nothing written", async () => {
    for (const [path, body] of POSTS) {
      await refused(gated("POST", path, body, undefined, { none: true }));
      const full = await gated("POST", path, body);
      for (const drop of ["x-oa-kid", "x-oa-sig"]) {
        const h = new Headers(full.headers);
        h.delete(drop);
        await refused(
          new Request(full.url, {
            method: "POST",
            headers: h,
            body: await full.clone().text(),
          }),
        );
      }
    }
    await nothingWritten();
  });

  it("a bad signature: garbage, or one for another route, 401, nothing written", async () => {
    for (const [path, body] of POSTS) {
      const good = await gated("POST", path, body);
      const h = new Headers(good.headers);
      h.set("x-oa-sig", "A".repeat(86));
      await refused(
        new Request(good.url, {
          method: "POST",
          headers: h,
          body: await good.clone().text(),
        }),
      );
      // Signed for the other POST, or for the auth broker's redeem.
      for (const other of [
        path === "/usage" ? "/trial/start" : "/usage",
        "/google/redeem",
      ])
        await refused(gated("POST", path, body, undefined, { path: other }));
    }
    await nothingWritten();
  });

  it("a stale or missing ts: 401, nothing written", async () => {
    at();
    for (const [path, body] of POSTS)
      for (const ts of [NOW - 60_001, NOW + 60_001, "x", null, undefined]) {
        await refused(gated("POST", path, { ...body, ts }));
      }
    // At the edge of the window it still passes.
    expect(
      (await call(gated("POST", "/usage", { install: A, ...usage, ts: NOW - 60_000 })))
        .status,
    ).toBe(200);
    await db.prepare("DELETE FROM usage").run();
    await nothingWritten();
  });

  it("another install's kid and key: 401, nothing written (the kid is checked against the gate's install, never the body's)", async () => {
    for (const [path, body] of POSTS) {
      // B signs a body naming B, but the gate says A.
      await refused(
        gated("POST", path, { ...body, install: B }, undefined, {
          key: KEYS[B],
        }),
      );
      // B signs a body with no install at all.
      const { install: _, ...rest } = body;
      await refused(gated("POST", path, rest, undefined, { key: KEYS[B] }));
      // A key the registry doesn't know.
      await refused(gated("POST", path, body, undefined, { key: pk(9) }));
    }
    await nothingWritten();
  });

  it("an unknown or disabled install: 401, nothing written", async () => {
    const C = "iccc111ccc11";
    for (const [path, body] of POSTS)
      await refused(
        gated("POST", path, { ...body, install: C }, {
          "x-oa-gate-install": C,
        }, { key: KEYS[A] }),
      );
    const x = await publicFromPkcs8(KEYS[A] as string);
    await registry.put(
      `install:${A}`,
      JSON.stringify({
        installId: A,
        origin: "https://a.example.test",
        keys: [{ kid: await keyId(x), x }],
        disabled: true,
      }),
    );
    clearRegistryCache();
    for (const [path, body] of POSTS) await refused(gated("POST", path, body));
    expect(await rowOf(C)).toBeNull();
    await nothingWritten();
  });

  it("a body tampered with after signing: 401, nothing written", async () => {
    for (const [path, body] of POSTS) {
      const signedText = JSON.stringify({ ...body, ts: Date.now() });
      // The signature is over signedText; the body sent differs.
      const tampered =
        path === "/usage"
          ? JSON.stringify({
              ...body,
              creators: ["u1", "u2"],
              count: 2,
              ts: Date.now(),
            })
          : `${signedText} `;
      await refused(
        gated("POST", path, tampered, undefined, { text: signedText }),
      );
    }
    await nothingWritten();
  });

  it("GET /tier and GET /health need no signature", async () => {
    expect((await call(gated("GET", "/tier"))).status).toBe(200);
    expect((await call(gated("GET", "/health"))).status).toBe(200);
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
      (await gated("GET", "/tier")) as Parameters<typeof billing.fetch>[0],
      broken,
    );
    expect(r.status).toBe(503);
    expect(lines).toEqual([`billing db_error ${A}`]);
  });
});
