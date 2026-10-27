// Review item 26: the hosted contract cases (packages/shared/test/
// hosted-contract.ts) against the real server, seeded with the mock's fixture
// world (same user and space ids). A case the server fails today is in
// KNOWN_GAPS (hosted.contract.gaps.ts) and runs as an expected failure, so a
// fix that makes it pass fails here until its entry is removed.
import { env } from "cloudflare:workers";
import { AUTH, R } from "@oa/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type ContractHosted,
  type ContractSetup,
  hostedContract,
} from "../../../packages/shared/test/hosted-contract.js";
import { createApp } from "../src/app.js";
import { sessionCookieName, signSession } from "../src/auth/session.js";
import type { Env } from "../src/env.js";
import { CID, mailer, TEST_BROKER_KEY } from "./auth-helpers.js";
import { fetchAndWait } from "./helpers.js";
import { KNOWN_GAPS, M1_OPEN } from "./hosted.contract.gaps.js";

const app = createApp();
const APP = "http://app.localhost";

// Hosted installs always run Turnstile on code requests (codes.ts). Siteverify,
// faked: any token passes except "fail" (the mock's refused token).
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const realFetch = globalThis.fetch;
beforeAll(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== SITEVERIFY) return realFetch(input, init);
    const token = new URLSearchParams(String(init?.body)).get("response");
    return Response.json({
      success: token !== "fail",
      hostname: "app.localhost",
      action: "code_request",
    });
  });
});
afterAll(() => vi.restoreAllMocks());

// ---- the mock's fixture world (packages/shared/src/mocks) -----------------
const U = {
  ada: {
    id: "Ab3dEfGhJk4mNpQr",
    email: "ada@example.com",
    name: "Ada Lovelace",
    role: "owner",
  },
  bob: {
    id: "Bc4eFgHjKm5nPqRs",
    email: "bob@example.com",
    name: "Bob Builder",
    role: "member",
  },
  carol: {
    id: "Cr7tNpQrSt8uVwXy",
    email: "carol@example.com",
    name: "Carol Departed",
    role: "member",
  },
  dan: {
    id: "Dn8uPqRsTu9vWxYz",
    email: "dan@example.com",
    name: "Dan Contractor",
    role: "member",
  },
  // The mock's Erin id (Er9vQrStUv0wXyZa) has a "0", not base58; cases find Erin by email.
  erin: {
    id: "Er9vQrStUv1wXyZa",
    email: "erin@example.com",
    name: "Erin Admin",
    role: "admin",
  },
} as const;
const ENG = "SpEngNpQrSt2uVwX";
const EXEC = "SpExcNpQrSt3uVwX";
const CLIENTS = "SpCliNpQrSt4uVwX";
const G = {
  eng: { id: "gEng01", email: "eng@example.com" },
  exec: { id: "gExec02", email: "exec@example.com" },
  sales: { id: "gSales03", email: "sales@example.com" },
  con: { id: "gCon04", email: "contractors@example.com" },
};
/** Fixture artifact ids (mocks/fixtures.ts) by title. */
const FIXTURE_ART: Record<string, string> = {
  "Landing page": "Cd5fGhJkLm6nPqRs",
  "Meeting notes": "De6gHjKmNp7qRsTu",
  "Parser script": "Ef7hJkLmNp8qRsTv",
  "Q4 report": "Fg8jKmNpQr9sTuVw",
  "Team poll": "Gh9kLmNpQrAsTuVx",
  "Shared draft": "JkBnPqRsTu5vWxYz",
  "Onboarding guide": "HjAmNpQrSt2uVwXy",
};

// ---- env: a hosted install as provision renders it, sign-in direct --------
const mail = mailer();
/** The ContractHosted options this driver implements; any other throws. */
const SUPPORTED: readonly (keyof ContractHosted)[] = [
  "mode",
  "providers",
  "turnstile",
  "directory",
  "unhealthy",
  "unhealthyState",
  "breakGlass",
  "actAs",
  "features",
];
const hostedOpts = (o: ContractSetup["hosted"]): ContractHosted => {
  const h = typeof o === "object" ? o : {};
  const bad = Object.keys(h).filter(
    (k) => !SUPPORTED.includes(k as keyof ContractHosted),
  );
  if (bad.length)
    throw new Error(`server driver: unsupported hosted option(s) ${bad}`);
  return h;
};
const hostedEnv = (o: ContractSetup["hosted"]): Env => {
  const h = hostedOpts(o);
  const sync =
    h.directory === "off"
      ? []
      : [h.directory === "frozen" ? "sync_frozen" : "sync_google"];
  const providers =
    h.mode === "access"
      ? "access"
      : (h.providers ?? ["google", "email"]).join(",");
  return {
    ...(env as object),
    ...mail.env,
    ENVIRONMENT: "production",
    PLAN: "paid",
    HOSTED: "1",
    INSTALL_ID: "inst-a",
    OWNER_EMAIL: U.ada.email,
    FEATURES: [
      "spaces",
      "content_revocation",
      "usage_off",
      ...sync,
      ...(h.features ?? []),
    ].join(","),
    AUTH_PROVIDERS: providers,
    // As the mock: domain codes exactly when email is on and Google is off.
    ...(providers.includes("email") && !providers.includes("google")
      ? { EMAIL_CODE_DOMAIN: "on" }
      : {}),
    AUTH_DOMAINS: "example.com",
    AUTH_DOMAIN_JOIN: "invite",
    GOOGLE_CLIENT_ID: CID,
    AUTH_BROKER_URL: "https://auth.hosted.test",
    BROKER_SIGNING_KEY: TEST_BROKER_KEY,
    DIRECTORY_TOKEN_KEY: "directory-token-key-0123456789abcdef",
    DIRECTORY_BROKER_URL: "https://directory.hosted.test",
    TURNSTILE_SITE_KEY: "turnstile-site-key",
    TURNSTILE_SECRET: "turnstile-secret",
  } as unknown as Env;
};
/** Self-host default: no HOSTED, no FEATURES. */
const offEnv = (): Env =>
  ({
    ...(env as object),
    OWNER_EMAIL: U.ada.email,
    FEATURES: "",
  }) as unknown as Env;

// ---- state ----------------------------------------------------------------
let E: Env = offEnv();
/** The session cookie's name in E (__Host-oa_session outside dev). */
const SESSION = () => sessionCookieName(E);
/** The caller's cookies (a browser jar: Set-Cookie updates it). */
const jar = new Map<string, string>();
/** Fixture artifact id -> the id the server gave it. */
const ids = new Map<string, string>();

const mapIds = (s: string) => {
  let out = s;
  for (const [f, real] of ids) out = out.split(f).join(real);
  return out;
};

async function raw(
  method: string,
  path: string,
  body: unknown,
  cookie: string,
): Promise<Response> {
  return fetchAndWait(
    app,
    new Request(`${APP}${path}`, {
      method,
      headers: {
        "x-oa-request": "1",
        "sec-fetch-site": "same-origin",
        "cf-connecting-ip": "198.51.100.7",
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    E,
  );
}

/**
 * The setup asked for no Turnstile (the mock's hosted default), which a real
 * hosted install never runs without: the driver then sends a widget token on
 * code requests, as the sign-in page does.
 */
let widget = false;
/** The address of the last AUTH.codeRequest, which code() reads the mail of. */
let codeTo: string | null = null;

async function call(method: string, path: string, body?: unknown) {
  let b =
    body === undefined ? undefined : JSON.parse(mapIds(JSON.stringify(body)));
  if (widget && path === AUTH.codeRequest && b && !("turnstileToken" in b))
    b = { ...b, turnstileToken: "widget-token" };
  if (path === AUTH.codeRequest)
    codeTo = typeof b?.email === "string" ? b.email.toLowerCase() : null;
  const r = await raw(
    method,
    mapIds(path),
    b,
    [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
  );
  for (const line of r.headers.getSetCookie()) {
    // Names may carry a __Host- prefix: split at the first "=" only.
    const [pair = "", ...attrs] = line.split(";");
    const i = pair.indexOf("=");
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    const gone = !value || attrs.some((a) => /max-age=0\b/i.test(a.trim()));
    if (gone) jar.delete(name);
    else jar.set(name, value);
  }
  return r;
}

async function sessionFor(userId: string, authAt?: number): Promise<string> {
  const row = await env.DB.prepare(
    "select session_epoch e from users where id = ?",
  )
    .bind(userId)
    .first<{ e: number }>();
  // A Google sign-in, or Access where Access is the only provider (hosted
  // off, mode "access").
  const access = !E.AUTH_PROVIDERS || E.AUTH_PROVIDERS === "access";
  return signSession(E, userId, Date.now(), {
    provider: access ? "access" : "google",
    tenant: access ? undefined : "example.com",
    epoch: row?.e ?? 0,
    // A forced Google re-authentication just now (break-glass fresh).
    ...(authAt !== undefined ? { authAt } : {}),
  });
}
async function signIn(email: string) {
  const row = await env.DB.prepare("select id from users where email = ?")
    .bind(email)
    .first<{ id: string }>();
  if (!row) throw new Error(`no fixture user ${email}`);
  jar.clear();
  jar.set(SESSION(), await sessionFor(row.id));
}

const run = (sql: string, ...binds: unknown[]) =>
  env.DB.prepare(sql).bind(...binds);

/** Empties every app table (migrations stay). */
async function wipe() {
  const { results } = await env.DB.prepare(
    "select name, sql from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '_cf_%' and name <> 'd1_migrations'",
  ).all<{ name: string; sql: string }>();
  // FTS shadow tables (<virtual>_data, ...) empty with their virtual table.
  const virtual = results
    .filter((t) => /^create virtual/i.test(t.sql))
    .map((t) => `${t.name}_`);
  const tables = results.filter(
    (t) => !virtual.some((v) => t.name.startsWith(v)),
  );
  await env.DB.batch([
    env.DB.prepare("pragma defer_foreign_keys = on"),
    ...tables.map((t) => env.DB.prepare(`delete from "${t.name}"`)),
  ]);
}

async function publishAs(
  who: keyof typeof U,
  title: string,
  extra: Record<string, unknown> = {},
) {
  const cookie = `${SESSION()}=${await sessionFor(U[who].id)}`;
  const r = await raw(
    "POST",
    R.artifacts,
    { title, format: extra.format ?? "html", content: "x", ...extra },
    cookie,
  );
  if (r.status !== 201)
    throw new Error(`seed publish ${title}: ${r.status} ${await r.text()}`);
  const id = ((await r.json()) as { id: string }).id;
  return { id, cookie };
}

/**
 * Directory health as the mock has it (mocks/hosted.ts `sync`): healthy, or
 * unhealthy for 2 h in unhealthyState (default backoff); held Sales sweep on
 * google only. breakGlass: a Workspace mismatch, which locks the synced owner
 * out of everything but break-glass.
 */
function health(h: ContractHosted, now: number) {
  const mismatch = h.breakGlass !== undefined;
  const state = mismatch
    ? "customer_mismatch"
    : h.unhealthy
      ? (h.unhealthyState ?? "backoff")
      : "ok";
  const since = state === "ok" ? null : now - 2 * 3600_000;
  return {
    state,
    value: JSON.stringify({
      state,
      unhealthySince: since,
      lastSuccessAt: since ?? now,
      lastError:
        since === null ? null : { at: now, message: "Google returned 503" },
      nextRunAt: null,
      alertedAt: null,
      customerMismatch: mismatch
        ? { expected: "C01mock", actual: "C02other" }
        : null,
      held:
        (h.directory ?? "google") === "google"
          ? [
              {
                groupId: G.sales.id,
                email: G.sales.email,
                name: "Sales",
                wouldRemove: 4,
                members: 4,
                since: new Date(
                  Date.parse("2026-01-01T00:00:00.000Z"),
                ).toISOString(),
              },
            ]
          : [],
      backoffN: 0,
      failState: since === null ? null : state,
      lanes: { fast: since === null ? null : state, rec: null },
      staleAt: null,
    }),
  };
}

/** The mock's hosted world (mocks/hosted.ts createHostedMock), in D1. */
async function seed(hosted: boolean, h: ContractHosted = {}) {
  const now = Date.now();
  const users = hosted ? Object.values(U) : [U.ada, U.bob];
  await env.DB.batch(
    users.map((u, i) =>
      run(
        "insert into users (id, email, name, role, created_at, last_seen_at) values (?, ?, ?, ?, ?, ?)",
        u.id,
        u.email,
        u.name,
        u.role,
        1_000 + i,
        u.id === U.dan.id ? null : now,
      ),
    ),
  );
  if (!hosted) {
    for (const [title, x] of [
      ["Landing page", {}],
      ["Meeting notes", { format: "markdown", visibility: "team" }],
    ] as const)
      ids.set(
        FIXTURE_ART[title] as string,
        (await publishAs("ada", title, x)).id,
      );
    return;
  }
  const T0 = Date.parse("2026-01-01T00:00:00.000Z");
  const google =
    h.mode !== "access" && (h.providers ?? ["google"]).includes("google");
  const dir = h.directory ?? "google";
  const hs = health(h, now);
  await env.DB.batch([
    // Owners and active members are Google-linked (when Google is on; an
    // email-only install has no Google links), bound to the connected
    // directory; Dan never signed in.
    ...(google ? [U.ada, U.bob, U.carol, U.erin] : []).map((u) =>
      run(
        "insert into identities (provider, subject, tenant, user_id, created_at, directory_bound) values ('google', ?, 'example.com', ?, ?, ?)",
        `sub-${u.id}`,
        u.id,
        now,
        dir === "google" ? 1 : 0,
      ),
    ),
    run(
      "insert into spaces (id, kind, name, all_members_role, public_links, created_at) values (?, 'shared', 'Engineering', 'viewer', 1, ?)",
      ENG,
      T0,
    ),
    run(
      "insert into spaces (id, kind, name, public_links, created_at) values (?, 'shared', 'Exec', 0, ?)",
      EXEC,
      T0,
    ),
    run(
      "insert into spaces (id, kind, name, public_links, created_at) values (?, 'shared', 'Clients', 1, ?)",
      CLIENTS,
      T0,
    ),
    ...Object.values(G).map((g) =>
      run(
        "insert into directory_groups (group_id, email) values (?, ?)",
        g.id,
        g.email,
      ),
    ),
    run(
      "insert into directory_members (group_id, user_id) values (?, ?)",
      G.eng.id,
      U.bob.id,
    ),
    run(
      "insert into directory_members (group_id, user_id) values (?, ?)",
      G.exec.id,
      U.ada.id,
    ),
    run(
      "insert into directory_members (group_id, user_id) values (?, ?)",
      G.con.id,
      U.dan.id,
    ),
    run(
      "insert into group_mappings (space_id, group_id, group_email, role) values (?, ?, ?, 'editor')",
      ENG,
      G.eng.id,
      G.eng.email,
    ),
    run(
      "insert into group_mappings (space_id, group_id, group_email, role) values (?, ?, ?, 'viewer')",
      EXEC,
      G.exec.id,
      G.exec.email,
    ),
    run(
      "insert into space_members (space_id, user_id, role, source, created_at) values (?, ?, 'manager', 'manual', ?)",
      ENG,
      U.ada.id,
      T0,
    ),
    run(
      "insert into space_members (space_id, user_id, role, source, created_at) values (?, ?, 'editor', 'sync', ?)",
      ENG,
      U.bob.id,
      T0,
    ),
    run(
      "insert into space_members (space_id, user_id, role, source, created_at) values (?, ?, 'viewer', 'sync', ?)",
      EXEC,
      U.ada.id,
      T0,
    ),
    run(
      "insert into restricted_groups (group_id, group_email, created_at) values (?, ?, ?)",
      G.con.id,
      G.con.email,
      T0,
    ),
    run("update users set restricted_sync = 1 where id = ?", U.dan.id),
    // A connected Google binding (none when the directory is off) and its health.
    ...(dir === "off"
      ? []
      : [
          run(
            "insert into directory_state (key, value) values ('binding', ?)",
            JSON.stringify({
              provider: "google",
              customerId: "C01mock",
              domain: "example.com",
              connectedBy: U.ada.email,
              connectedAt: new Date(T0).toISOString(),
            }),
          ),
          run(
            "insert into directory_state (key, value) values ('sync.state', ?)",
            hs.state,
          ),
          run(
            "insert into directory_state (key, value) values ('sync.health', ?)",
            hs.value,
          ),
        ]),
  ]);
  // Artifacts (fixtures.ts), published for real; "Meeting notes" lives in
  // Engineering. Bob's "Shared draft" is shared with Ada as an editor.
  const mine: [string, Record<string, unknown>][] = [
    ["Landing page", {}],
    ["Meeting notes", { format: "markdown", visibility: "team", spaceId: ENG }],
    ["Parser script", { format: "code", language: "typescript" }],
    ["Q4 report", { format: "markdown", visibility: "public" }],
    [
      "Team poll",
      {
        visibility: "public",
        capabilities: { db: true },
        allowAnonymousWrites: true,
      },
    ],
  ];
  for (const [title, x] of mine)
    ids.set(
      FIXTURE_ART[title] as string,
      (await publishAs("ada", title, x)).id,
    );
  const draft = await publishAs("bob", "Shared draft", { format: "markdown" });
  ids.set(FIXTURE_ART["Shared draft"] as string, draft.id);
  const share = await raw(
    "PUT",
    R.shares(draft.id),
    { email: U.ada.email, role: "editor" },
    draft.cookie,
  );
  if (!share.ok) throw new Error(`seed share: ${share.status}`);
  ids.set(
    FIXTURE_ART["Onboarding guide"] as string,
    (
      await publishAs("bob", "Onboarding guide", {
        format: "markdown",
        visibility: "team",
      })
    ).id,
  );
  // A share admits guest@outside.org as a guest (the mock admits any address).
  const guestShare = await raw(
    "PUT",
    R.shares(ids.get(FIXTURE_ART["Landing page"] as string) as string),
    { email: "guest@outside.org", role: "viewer" },
    `${SESSION()}=${await sessionFor(U.ada.id)}`,
  );
  if (!guestShare.ok) throw new Error(`seed guest share: ${guestShare.status}`);
  // Carol (suspended): two live personal artifacts and one deleted.
  const c = [];
  for (const t of ["c1", "c2", "c3"]) c.push(await publishAs("carol", t));
  const del = await raw(
    "DELETE",
    R.artifact(c[2]?.id as string),
    undefined,
    c[2]?.cookie as string,
  );
  if (!del.ok) throw new Error(`seed delete: ${del.status}`);
  await run(
    "update users set status = 'suspended' where id = ?",
    U.carol.id,
  ).run();
  // The world starts with an empty audit log, as the mock's does.
  await run("delete from audit_events").run();
}

async function fresh(o: ContractSetup = {}) {
  const extra = Object.keys(o).filter((k) => k !== "hosted");
  if (extra.length)
    throw new Error(`server driver: unsupported setup option(s) ${extra}`);
  const hosted = o.hosted !== undefined && o.hosted !== false;
  const h = hostedOpts(o.hosted);
  ids.clear();
  jar.clear();
  mail.sent.length = 0;
  codeTo = null;
  await wipe();
  E = hosted ? hostedEnv(o.hosted) : offEnv();
  // Seeding publishes as the fixture users, which a Workspace mismatch would
  // refuse: the mismatch lands after the world is seeded.
  await seed(hosted, { ...h, breakGlass: undefined });
  if (h.breakGlass) {
    const hs = health(h, Date.now());
    await env.DB.batch([
      run(
        "update directory_state set value = ? where key = 'sync.state'",
        hs.state,
      ),
      run(
        "update directory_state set value = ? where key = 'sync.health'",
        hs.value,
      ),
    ]);
  }
  widget = hosted && !h.turnstile;
  await signIn(h.actAs === "admin" ? U.erin.email : U.ada.email);
  // Break-glass "fresh": a forced Google re-authentication just now.
  if (h.breakGlass === "fresh")
    jar.set(SESSION(), await sessionFor(U.ada.id, Date.now()));
}

const cases = hostedContract({
  mock: false,
  fresh,
  call,
  signIn,
  code: async () => {
    if (!codeTo) throw new Error("no code requested");
    return mail.codeFor(codeTo);
  },
  knownGaps: KNOWN_GAPS,
});

describe("KNOWN_GAPS", () => {
  it("names only real cases the server runs", () => {
    for (const name of Object.keys(KNOWN_GAPS)) {
      expect(cases.names, name).toContain(name);
      expect(cases.mswOnly.has(name), name).toBe(false);
    }
  });

  it("lists the M1 gaps still open (the M1 gate needs this empty)", () => {
    const m1 = Object.entries(KNOWN_GAPS)
      .filter(([, g]) => g.m1)
      .map(([name, g]) => `${g.item}: ${name}`)
      .sort();
    console.log(`M1 gaps open (${m1.length}):\n${m1.join("\n")}`);
    expect(m1).toEqual(M1_OPEN);
  });
});

// The fixture world seeds and the driver signs in, without any case.
describe("server driver", () => {
  it("seeds the fixture world and signs in as the owner", async () => {
    await fresh({ hosted: true });
    const me = (await (await call("GET", R.me)).json()) as {
      user: { id: string };
    };
    expect(me.user.id).toBe(U.ada.id);
  });

  it("throws on a setup option it doesn't implement", async () => {
    const tier = { hosted: { tier: "team" } } as unknown as ContractSetup;
    await expect(fresh(tier)).rejects.toThrow(/unsupported hosted option/);
  });
});
