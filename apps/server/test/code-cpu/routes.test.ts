// The CPU bar, half 2 (docs/ops/cpu-budget.md): CODE CPU ≤ 2 ms per route.
// Node proxy like scripts/bench.ts: the real Worker against in-process
// bindings, metered with the thread CPU clock minus D1/R2 shims and DO
// methods (DO rows meter the DO invocation itself). Per route: REPEATS
// rounds, each a p95 of RUNS requests after warm-up for the route and for
// GET /api/v1/me back to back; the bar is the median per-round ratio.
// Part of `pnpm test:cpu`.
import { GOOGLE_JWKS_URL, GOOGLE_TOKEN_URL } from "@oa/auth-core";
import { AUTH, LIMITS, newId } from "@oa/shared";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  apiReq,
  type BenchEnv,
  type Ctx,
  call,
  htmlDoc,
  ok,
  type Scenario,
  sample,
  setup,
  summarize,
} from "../../scripts/bench.js";
import { FakeSocket, meterDo } from "../../scripts/bench-env.js";
import { getDb } from "../../src/db/client.js";
import { users } from "../../src/db/schema.js";
import type { ArtifactRuntime } from "../../src/runtime/do.js";

const BAR_MS = 2;
/** Sign-in rows (P2 T10): their own bars, in the same reference-machine ms. */
const SIGNIN_MS = { providers: 1, google: 3, codeRequest: 2, codeVerify: 2 };
const CID = "cid.apps.googleusercontent.com";
/**
 * The one row with its own bar: an owner-only data reset (R.dataReset) rewrites
 * a whole snapshot (500 docs / 1 MB on Free) in one DO transaction. Rare (a
 * nightly demo reset), so it gets most of the 10 ms instead of the 2 ms
 * per-request bar; the Worker side stays under 2 ms.
 */
const RESET_DO_MS = 8;
/**
 * The bar is in reference-machine ms (the dev laptop the rows in
 * docs/ops/cpu-budget.md came from), asserted as a ratio: each round measures
 * the row's p95 and `GET /api/v1/me`'s p95 back to back (order alternating),
 * and the median of rowP95 / meP95 must stay at or under budgetMs / REF_ME_MS.
 * Same process, same moment, so a slower or busier runner (CI is about 3×,
 * and shared-runner load changes mid-suite) cancels out. A one-off scale
 * measured in beforeAll didn't: load that changed later skewed every row.
 */
const REF_ME_MS = 0.56;
/**
 * The calibration route can't be checked by ratio against itself, and a
 * regression in it would widen every other row's bar. So GET /api/v1/me
 * alone keeps an absolute bar: budgetMs × MAX_SCALE (the most a runner may
 * be slower than the reference laptop).
 */
const MAX_SCALE = 4;
const CALIBRATION = "GET /api/v1/me";
/** Open R.events sockets on the "publish with event sockets" rows. */
const EVENTS_SOCKETS = 50;
const RUNS = 20;
const REPEATS = 5;
const APP = "http://app.localhost";

/** HTML where every content byte needs a JSON escape (`"` and `\`). */
const escapeHeavy = (bytes: number) =>
  `<p class="a\\b">${'"\\'.repeat(bytes / 2)}</p>`.slice(0, bytes);

let c: Ctx;
/** The fake Google: one RS256 key; the next token response is set per iteration. */
let gKey: CryptoKeyPair;
let gJwk: Record<string, unknown>;
let nextIdToken = "";
beforeAll(async () => {
  gKey = await generateKeyPair("RS256", { extractable: true });
  gJwk = { ...(await exportJWK(gKey.publicKey)), kid: "g1", alg: "RS256" };
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === GOOGLE_JWKS_URL) return Response.json({ keys: [gJwk] });
    if (url === GOOGLE_TOKEN_URL)
      return Response.json({ id_token: nextIdToken });
    return real(input, init);
  });
  for (const k of ["log", "warn"] as const)
    vi.spyOn(console, k).mockImplementation(() => {});
  c = await setup();
}, 120_000);
afterAll(() => vi.restoreAllMocks());

/** The bench env with direct sign-in (Google direct and codes) and a fake mailer. */
function signInEnv(): { env: BenchEnv; codeFor: (to: string) => string } {
  const sent: { to: string; text: string }[] = [];
  const env = {
    ...c.env,
    AUTH_PROVIDERS: "google,email",
    AUTH_DOMAINS: "a.com",
    AUTH_DOMAIN_JOIN: "member",
    GOOGLE_CLIENT_ID: CID,
    GOOGLE_CLIENT_SECRET: "s",
    INSTALL_ID: "inst-a",
    EMAIL_FROM: "noreply@mail.example.com",
    EMAIL: {
      async send(m: { to: string; text: string }) {
        sent.push(m);
        return { messageId: `m${sent.length}` };
      },
    },
  } as unknown as BenchEnv;
  const codeFor = (to: string) => {
    const m = [...sent].reverse().find((x) => x.to === to);
    const d = m?.text.match(/\b(\d{4}) (\d{4})\b/);
    if (!d) throw new Error("no code sent");
    return `${d[1]}${d[2]}`;
  };
  return { env, codeFor };
}

let ipN = 0;
let mailN = 0;
/** A sign-in POST from a fresh IP (the per-IP counters never cap a run). */
const signInPost = (path: string, body: unknown, cookie?: string) =>
  new Request(`${APP}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-oa-request": "1",
      "sec-fetch-site": "same-origin",
      "cf-connecting-ip": `10.${(ipN >> 16) & 255}.${(ipN >> 8) & 255}.${ipN++ & 255}`,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
const cookieOf = (r: Response, re: RegExp) =>
  r.headers
    .getSetCookie()
    .find((x) => re.test(x))
    ?.split(";")[0];
/** A guest row for a fresh address, and the daily send pool reset; unmetered. */
async function seedGuest(env: BenchEnv): Promise<string> {
  env.DB.sqlite.prepare("delete from counters where key = 'code:*'").run();
  const email = `cpu-${mailN++}@x.com`;
  await getDb(env).insert(users).values({
    id: newId(),
    email,
    name: "cpu",
    role: "guest",
    createdAt: Date.now(),
  });
  return email;
}

function signInRoutes(): Scenario[] {
  const s = signInEnv();
  const { env } = s;
  const w = (
    name: string,
    budgetMs: number,
    prepare: Scenario["prepare"],
  ): Scenario => ({ name, budgetMs, bucket: "worker", prepare });
  return [
    w("GET /auth/providers", SIGNIN_MS.providers, async () =>
      step(env, new Request(`${APP}${AUTH.providers}`), "providers"),
    ),
    w(
      "Google callback (RS256 verify, admission, session)",
      SIGNIN_MS.google,
      async () => {
        const start = await call(
          env,
          new Request(`${APP}${AUTH.loginGoogle}?next=/`),
        );
        const u = new URL(start.headers.get("location") ?? "");
        const cookie = cookieOf(start, /oa_oidc_/);
        if (!cookie) throw new Error("no state cookie");
        const now = Math.floor(Date.now() / 1000);
        const n = mailN++;
        nextIdToken = await new SignJWT({
          iss: "https://accounts.google.com",
          aud: CID,
          azp: CID,
          sub: `cpu-sub-${n}`,
          email: `cpu-g${n}@a.com`,
          email_verified: true,
          hd: "a.com",
          nonce: u.searchParams.get("nonce"),
          iat: now,
          exp: now + 3600,
        })
          .setProtectedHeader({ alg: "RS256", kid: "g1" })
          .sign(gKey.privateKey);
        const r = new Request(
          `${APP}${AUTH.callbackGoogle}?state=${u.searchParams.get("state")}&code=c${n}`,
          { headers: { cookie } },
        );
        return async () => {
          const res = await call(env, r);
          const loc = res.headers.get("location") ?? "";
          if (res.status !== 302 || loc.includes("error="))
            throw new Error(`google callback: ${res.status} ${loc}`);
        };
      },
    ),
    w("POST code request", SIGNIN_MS.codeRequest, async () => {
      const email = await seedGuest(env);
      return async () => {
        const res = await call(env, signInPost(AUTH.codeRequest, { email }));
        if (res.status !== 202) throw new Error(`code request: ${res.status}`);
      };
    }),
    w("POST code verify", SIGNIN_MS.codeVerify, async () => {
      const email = await seedGuest(env);
      const req = await call(env, signInPost(AUTH.codeRequest, { email }));
      const cookie = cookieOf(req, /^oa_code=/);
      const r = signInPost(AUTH.codeVerify, { code: s.codeFor(email) }, cookie);
      return step(env, r, "code verify");
    }),
  ];
}

/** p95 of RUNS requests after warm-up. */
const p95Of = async (s: Scenario) => summarize(s, await sample(s, RUNS, 5)).p95;
const median = (xs: number[]) =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ??
  Number.POSITIVE_INFINITY;

/**
 * REPEATS rounds of the row's p95 and the calibration's p95, back to back,
 * the order alternating so neither always runs first. Returns each round's
 * rowP95 / meP95.
 */
async function ratios(s: Scenario, me: Scenario) {
  const out: { row: number; me: number; ratio: number }[] = [];
  for (let i = 0; i < REPEATS; i++) {
    let row: number;
    let cal: number;
    if (i % 2 === 0) {
      cal = await p95Of(me);
      row = await p95Of(s);
    } else {
      row = await p95Of(s);
      cal = await p95Of(me);
    }
    out.push({ row, me: cal, ratio: row / cal });
  }
  return out;
}

const json = (x: unknown) => JSON.stringify(x);
const req = (path: string, method = "GET", body?: string) =>
  apiReq(c.token, path, method, body);
/** The metered step; `r` is built per iteration in prepare (unmetered). */
const step = (env: BenchEnv, r: Request, what: string) => () =>
  call(env, r).then((x) => ok(x, what));

/** An upload (create, then PUT unless `put` is false); unmetered. */
async function upload(env: BenchEnv, page: string, put = true) {
  const up = (await (
    await ok(
      await call(
        env,
        req(
          "/api/v1/uploads",
          "POST",
          json({ path: "index.html", size: page.length }),
        ),
      ),
      "upload create",
    )
  ).json()) as { uploadId: string; artifactId: string; url: string };
  const u = new URL(up.url);
  const putReq = () =>
    new Request(`${APP}${u.pathname}${u.search}`, {
      method: "PUT",
      body: page,
      headers: { "content-length": String(page.length) },
    });
  if (put) await ok(await call(env, putReq()), "upload PUT");
  return { ...up, putReq };
}

function routes(): Scenario[] {
  const { env } = c;
  const spacesOn = { ...env, FEATURES: "spaces" } as BenchEnv;
  const page = htmlDoc(250 * 1024);
  const inline = json({
    title: "Escape-heavy",
    format: "html",
    content: escapeHeavy(LIMITS.inlineBytes - 64),
  });
  // Just under the Free data-doc limit (256 KB of JSON as received).
  const doc256 = json({
    text: "budget word ".repeat((LIMITS.dataDocBytesFree - 64) / 12),
  });
  let dataId = "";
  let resetId = "";
  let eventsId = "";
  let evN = 2;
  let docN = 0;
  let writes = 0;
  // A full-size Free data reset: 500 docs filling the 1 MB snapshot cap.
  const snapshot = json({
    collections: {
      c: Object.fromEntries(
        Array.from({ length: LIMITS.dataResetDocsFree }, (_, i) => [
          `d${i}`,
          { i, text: "budget word ".repeat(170) },
        ]),
      ),
    },
  });
  if (snapshot.length > LIMITS.dataResetBytesFree)
    throw new Error(`snapshot ${snapshot.length} B is over the cap`);
  const w = (name: string, prepare: Scenario["prepare"]): Scenario => ({
    name,
    budgetMs: BAR_MS,
    bucket: "worker",
    prepare,
  });
  return [
    w("GET /healthz", async () =>
      step(env, new Request(`${APP}/healthz`), "healthz"),
    ),
    w("GET /api/v1/me", async () => step(env, req("/api/v1/me"), "me")),
    w("list 25", async () =>
      step(env, req("/api/v1/artifacts?limit=25"), "list"),
    ),
    w("search", async () =>
      step(env, req("/api/v1/search?q=budget%20note"), "search"),
    ),
    // Spaces on: every row also carries `space` and `can` (P3 T10).
    w("list 25 (spaces)", async () =>
      step(spacesOn, req("/api/v1/artifacts?limit=25"), "list"),
    ),
    w("search (spaces)", async () =>
      step(spacesOn, req("/api/v1/search?q=budget%20note"), "search"),
    ),
    w("inline publish 128 KB escape-heavy", async () =>
      step(env, req("/api/v1/artifacts", "POST", inline), "publish inline"),
    ),
    w("upload create", async () =>
      step(
        env,
        req(
          "/api/v1/uploads",
          "POST",
          json({ path: "index.html", size: page.length }),
        ),
        "upload create",
      ),
    ),
    w("upload PUT 250 KB", async () => {
      const up = await upload(env, page, false);
      return step(env, up.putReq(), "upload PUT");
    }),
    w("publish { uploadId } 250 KB html", async () => {
      const up = await upload(env, page);
      return step(
        env,
        req(
          "/api/v1/artifacts",
          "POST",
          json({
            id: up.artifactId,
            title: "Big page",
            files: { "index.html": { uploadId: up.uploadId } },
          }),
        ),
        "publish upload",
      );
    }),
    ...(["worker", "do"] as const).map(
      (bucket): Scenario => ({
        name: `data doc write 256 KB (${bucket})`,
        budgetMs: BAR_MS,
        bucket,
        prepare: async () => {
          if (!dataId) {
            const r = await ok(
              await call(
                env,
                req(
                  "/api/v1/artifacts",
                  "POST",
                  json({
                    title: "db",
                    format: "html",
                    content: "<p>live</p>",
                    capabilities: { db: true },
                  }),
                ),
              ),
              "publish db",
            );
            dataId = ((await r.json()) as { id: string }).id;
          }
          // The DO allows 100 writes/min per actor: move its clock a minute every 90.
          const obj = env.ARTIFACT_RUNTIME.instance(dataId)
            .obj as unknown as ArtifactRuntime;
          const minute = Math.floor(writes++ / 90);
          obj.now = () => Date.now() + minute * 60_000;
          return step(
            env,
            req(
              `/api/v1/artifacts/${dataId}/data/c/d${docN++ % 20}`,
              "PUT",
              doc256,
            ),
            "data write",
          );
        },
      }),
    ),
    ...(["worker", "do"] as const).map(
      (bucket): Scenario => ({
        name: `data reset 1 MB (${bucket})`,
        budgetMs: bucket === "do" ? RESET_DO_MS : BAR_MS,
        bucket,
        prepare: async () => {
          if (!resetId) {
            const r = await ok(
              await call(
                env,
                req(
                  "/api/v1/artifacts",
                  "POST",
                  json({
                    title: "reset",
                    format: "html",
                    content: "<p>live</p>",
                    capabilities: { db: true },
                  }),
                ),
              ),
              "publish db",
            );
            resetId = ((await r.json()) as { id: string }).id;
          }
          const obj = env.ARTIFACT_RUNTIME.instance(resetId)
            .obj as unknown as ArtifactRuntime;
          const minute = Math.floor(writes++ / 90);
          obj.now = () => Date.now() + minute * 60_000;
          return step(
            env,
            req(`/api/v1/artifacts/${resetId}/data`, "PUT", snapshot),
            "data reset",
          );
        },
      }),
    ),
    // A publish's version frame to EVENTS_SOCKETS open R.events sockets
    // (half named, half anonymous): broadcast inside scheduleIndex, the RPC
    // publish already makes.
    ...(["worker", "do"] as const).map(
      (bucket): Scenario => ({
        name: `publish with ${EVENTS_SOCKETS} event sockets (${bucket})`,
        budgetMs: BAR_MS,
        bucket,
        prepare: async () => {
          if (!eventsId) {
            const r = await ok(
              await call(
                env,
                req(
                  "/api/v1/artifacts",
                  "POST",
                  json({ title: "ev", format: "html", content: "<p>1</p>" }),
                ),
              ),
              "publish events",
            );
            eventsId = ((await r.json()) as { id: string }).id;
            const { state } = env.ARTIFACT_RUNTIME.instance(eventsId);
            for (let i = 0; i < EVENTS_SOCKETS; i++)
              state.acceptWebSocket(new FakeSocket([]), [
                "~ev",
                i % 2 ? "~ev:named" : "~ev:anon",
              ]);
          }
          const socks = env.ARTIFACT_RUNTIME.instance(eventsId).state.sockets;
          const run = step(
            env,
            req(
              `/api/v1/artifacts/${eventsId}/versions`,
              "POST",
              json({ format: "html", content: `<p>${evN++}</p>` }),
            ),
            "publish version",
          );
          return async () => {
            const before = socks.map((s) => s.frames);
            await run();
            if (socks.some((s, i) => s.frames !== (before[i] ?? 0) + 1))
              throw new Error("a socket missed the version frame");
          };
        },
      }),
    ),
    {
      name: "index alarm 64 KB html (do)",
      budgetMs: BAR_MS,
      bucket: "do",
      prepare: async () => {
        const r = await ok(
          await call(
            env,
            req(
              "/api/v1/artifacts",
              "POST",
              json({ title: "A", format: "html", content: htmlDoc(64 * 1024) }),
            ),
          ),
          "publish",
        );
        const { id } = (await r.json()) as { id: string };
        const obj = env.ARTIFACT_RUNTIME.instance(id)
          .obj as unknown as ArtifactRuntime;
        if (!obj.pendingIndex()) throw new Error("nothing pending to index");
        return async () => {
          await meterDo(() => obj.alarm());
          if (obj.pendingIndex()) throw new Error("alarm did not index");
        };
      },
    },
  ];
}

describe(`code CPU ≤ ${BAR_MS} ms per route (p95, median of ${REPEATS})`, () => {
  const names = [
    "GET /healthz",
    "GET /api/v1/me",
    "list 25",
    "search",
    "list 25 (spaces)",
    "search (spaces)",
    "inline publish 128 KB escape-heavy",
    "upload create",
    "upload PUT 250 KB",
    "publish { uploadId } 250 KB html",
    "data doc write 256 KB (worker)",
    "data doc write 256 KB (do)",
    "data reset 1 MB (worker)",
    "data reset 1 MB (do)",
    `publish with ${EVENTS_SOCKETS} event sockets (worker)`,
    `publish with ${EVENTS_SOCKETS} event sockets (do)`,
    "index alarm 64 KB html (do)",
    "GET /auth/providers",
    "Google callback (RS256 verify, admission, session)",
    "POST code request",
    "POST code verify",
  ];
  for (const name of names)
    it(name, async ({ annotate }) => {
      const all = [...routes(), ...signInRoutes()];
      const s = all.find((r) => r.name === name);
      const me = all.find((r) => r.name === CALIBRATION);
      if (!s || !me) throw new Error(`no scenario ${name}`);
      const f = (x: number) => x.toFixed(2);
      if (s === me) {
        // Absolute: the calibration route can't hide behind its own ratio.
        const p95s: number[] = [];
        for (let i = 0; i < REPEATS; i++) p95s.push(await p95Of(s));
        const p95 = median(p95s);
        const limit = s.budgetMs * MAX_SCALE;
        await annotate(
          `p95 ${f(p95)} ms, absolute bar ${f(limit)} (${s.budgetMs} × ${MAX_SCALE}) (runs: ${p95s.map(f).join(", ")})`,
        );
        expect(p95).toBeLessThanOrEqual(limit);
        return;
      }
      const rounds = await ratios(s, me);
      const ratio = median(rounds.map((r) => r.ratio));
      const bar = s.budgetMs / REF_ME_MS;
      await annotate(
        `ratio ${f(ratio)} (≈ ${f(ratio * REF_ME_MS)} ms on the reference laptop), bar ${f(bar)} (${s.budgetMs} / ${REF_ME_MS}) (runs, row / me ms: ${rounds.map((r) => `${f(r.row)} / ${f(r.me)}`).join(", ")})`,
      );
      expect(ratio).toBeLessThanOrEqual(bar);
    }, 120_000);
});
