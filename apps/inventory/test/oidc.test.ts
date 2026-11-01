import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  GITHUB_OIDC_ISSUER,
  GITHUB_OIDC_JWKS_URL,
  verify as ghVerify,
  JwksCache,
  OidcError,
} from "@oa/gh-oidc";
import { beforeAll, describe, expect, it } from "vitest";
import { pinsFromEnv } from "../src/auth.ts";
import defaultWorker, { makeWorker } from "../src/index.ts";
import {
  BEARER,
  JWT,
  MONITOR,
  makeEnv,
  NOW,
  REDLINE,
  REPO,
  req,
  VARS,
  worker,
} from "./support.ts";

const PATHS = ["/installs", "/hosts", "/hosts?host=a.test", "/health"];

async function expectFixed(res: Response, status: number, error: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.text()).toBe(JSON.stringify({ error }));
}

type Wire = {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
};
const wire = async (res: Response): Promise<Wire> => ({
  status: res.status,
  statusText: res.statusText,
  headers: [...res.headers],
  body: await res.text(),
});

/** What an authenticated caller gets for an unknown route. */
let unknownRoute: Wire;
beforeAll(async () => {
  unknownRoute = await wire(
    await worker().w.fetch(req("/nope", {}, BEARER), makeEnv()),
  );
  expect(unknownRoute.status).toBe(404);
  expect(unknownRoute.body).toBe("Not found");
});

/** An auth failure is the unknown-route 404: status, headers and body. */
async function expectPlain404(res: Response, what?: string) {
  expect(await wire(res), what).toEqual(unknownRoute);
}

describe("production wiring", () => {
  it("the default export uses @oa/gh-oidc's verify, which fails closed: any bearer is the plain 404", async () => {
    for (const p of [...PATHS, "/prodclean", "/nope"])
      await expectPlain404(
        await defaultWorker.fetch(
          req(p, { method: p === "/prodclean" ? "POST" : "GET" }, BEARER),
          makeEnv(),
        ),
        p,
      );
  });
});

describe("bearer", () => {
  const cases: [string, string | undefined][] = [
    ["no header", undefined],
    ["a wrong scheme", `Basic ${JWT}`],
    ["a bare token", JWT],
    ["an empty bearer", "Bearer "],
    ["an empty header", ""],
    ["a bearer with a space", `Bearer ${JWT} x`],
    ["a wrong token", "Bearer x.y.z"],
    ["an oversized bearer", `Bearer ${"a".repeat(8193)}`],
  ];
  for (const [what, auth] of cases)
    it(`${what} -> the plain 404 on every path`, async () => {
      const { w, calls } = worker();
      for (const p of [...PATHS, "/nope"])
        await expectPlain404(await w.fetch(req(p, {}, auth), makeEnv()), p);
      await expectPlain404(
        await w.fetch(req("/prodclean", { method: "POST" }, auth), makeEnv()),
      );
      // A wrong method is 405 only after auth: it never leaks a route.
      await expectPlain404(
        await w.fetch(req("/installs", { method: "POST" }, auth), makeEnv()),
      );
      if (what !== "a wrong token") expect(calls).toEqual([]);
    });

  it("an OidcError's code never reaches the response", async () => {
    const w = makeWorker({
      verify: async () => {
        throw new OidcError("bad_sig");
      },
      now: () => 0,
    });
    await expectPlain404(
      await w.fetch(req("/installs", {}, BEARER), makeEnv()),
    );
  });

  it("a non-Oidc throw (a JWKS fetch failing) is the same 404", async () => {
    const w = makeWorker({
      verify: async () => {
        throw new TypeError("fetch failed: jwks.example");
      },
      now: () => 0,
    });
    await expectPlain404(await w.fetch(req("/health", {}, BEARER), makeEnv()));
  });

  it("verify gets the bearer and exactly the parsed pins", async () => {
    const { w, calls } = worker();
    await w.fetch(req("/health", {}, BEARER), makeEnv());
    expect(calls).toEqual([
      {
        jwt: JWT,
        pins: {
          audience: VARS.OIDC_AUDIENCE,
          repository: REPO,
          repositoryId: VARS.OIDC_REPOSITORY_ID,
          jobWorkflowRefs: [REDLINE, MONITOR],
          environment: "redline-staging",
        },
      },
    ]);
  });
});

// Every claim failure through the real @oa/gh-oidc verify: a local RS256 key,
// a stubbed JWKS fetch and the pinned clock, so nothing reaches the network.
describe("real verifier: every failure class is the plain 404", () => {
  const b64u = (b: ArrayBuffer | string) => {
    const bytes =
      typeof b === "string" ? new TextEncoder().encode(b) : new Uint8Array(b);
    let s = "";
    for (const x of bytes) s += String.fromCharCode(x);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };

  let priv: CryptoKey;
  let jwks: string;
  beforeAll(async () => {
    const k = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    priv = k.privateKey;
    const jwk = await crypto.subtle.exportKey("jwk", k.publicKey);
    jwks = JSON.stringify({
      keys: [{ kty: jwk.kty, n: jwk.n, e: jwk.e, kid: "k1", alg: "RS256" }],
    });
  });

  const S = NOW / 1000;
  const good = (): Record<string, unknown> => ({
    iss: GITHUB_OIDC_ISSUER,
    aud: VARS.OIDC_AUDIENCE,
    sub: `repo:${REPO}:environment:redline-staging`,
    iat: S - 10,
    nbf: S - 10,
    exp: S + 290,
    repository: REPO,
    repository_id: VARS.OIDC_REPOSITORY_ID,
    ref: "refs/heads/main",
    job_workflow_ref: MONITOR,
    environment: "redline-staging",
    event_name: "schedule",
    runner_environment: "github-hosted",
  });

  const sign = async (claims: Record<string, unknown>) => {
    const h = b64u(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }));
    const p = b64u(JSON.stringify(claims));
    const sig = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      priv,
      new TextEncoder().encode(`${h}.${p}`),
    );
    return `${h}.${p}.${b64u(sig)}`;
  };

  /** The real verify; `jwksRes` null makes the JWKS fetch throw. */
  const real = (jwksRes: () => Response | null = () => new Response(jwks)) =>
    makeWorker({
      verify: (jwt, pins) =>
        ghVerify(jwt, pins, {
          fetch: (async (u: string | URL | Request) => {
            if (String(u) !== GITHUB_OIDC_JWKS_URL)
              throw new Error(`unexpected fetch ${String(u)}`);
            const r = jwksRes();
            if (!r) throw new TypeError("fetch failed");
            return r;
          }) as typeof fetch,
          now: () => NOW,
          jwks: new JwksCache(),
          cache: null,
        }),
      now: () => NOW,
    });

  const all = async (
    w: ReturnType<typeof real>,
    auth: string,
    env = makeEnv(),
  ) => {
    for (const p of [...PATHS, "/nope"])
      await expectPlain404(await w.fetch(req(p, {}, auth), env), p);
    await expectPlain404(
      await w.fetch(req("/prodclean", { method: "POST" }, auth), env),
      "/prodclean",
    );
  };

  it("control: the good token reads /installs (200)", async () => {
    const res = await real().fetch(
      req("/installs", {}, `Bearer ${await sign(good())}`),
      makeEnv(),
    );
    expect(res.status).toBe(200);
  });

  const claimCases: [string, Record<string, unknown>][] = [
    ["an expired token", { iat: S - 600, nbf: S - 600, exp: S - 61 }],
    ["a wrong audience", { aud: "https://oa-x-inventory" }],
    ["a wrong repository", { repository: "someone/else" }],
    ["a wrong repository id", { repository_id: "999" }],
    ["a wrong ref", { ref: "refs/heads/feature" }],
    [
      "a wrong workflow ref",
      { job_workflow_ref: `${REPO}/.github/workflows/ci.yml@refs/heads/main` },
    ],
    ["a wrong environment", { environment: "production" }],
    ["a wrong event", { event_name: "pull_request" }],
    ["a wrong runner", { runner_environment: "self-hosted" }],
  ];
  for (const [what, over] of claimCases)
    it(`${what} -> the plain 404 on every path`, async () => {
      await all(real(), `Bearer ${await sign({ ...good(), ...over })}`);
    });

  it("a malformed token -> the plain 404 on every path", async () => {
    for (const t of ["a.b", "a..c", "not-base64.%%%.x", `${JWT}`])
      await all(real(), `Bearer ${t}`);
  });

  it("a staging token on prod -> the plain 404 on every path", async () => {
    const staging = await sign({ ...good(), aud: "https://oa-s-inventory" });
    await all(
      real(),
      `Bearer ${staging}`,
      makeEnv({ OIDC_AUDIENCE: "https://oa-p-inventory" }),
    );
  });

  it("a JWKS fetch failure (throw or non-200) -> the plain 404 on every path", async () => {
    const t = `Bearer ${await sign(good())}`;
    await all(
      real(() => null),
      t,
    );
    await all(
      real(() => new Response("down", { status: 503 })),
      t,
    );
  });
});

describe("vars fail closed", () => {
  const KEYS = Object.keys(VARS) as (keyof typeof VARS)[];
  for (const k of KEYS)
    for (const v of [undefined, "", "   "])
      it(`${k} ${v === undefined ? "missing" : JSON.stringify(v)} -> 503, verify never called`, async () => {
        const { w, calls } = worker();
        const env = makeEnv({ [k]: v });
        for (const p of PATHS)
          await expectFixed(
            await w.fetch(req(p, {}, BEARER), env),
            503,
            "unavailable",
          );
        // Before the header is read: no bearer is still 503.
        await expectFixed(
          await w.fetch(req("/installs"), env),
          503,
          "unavailable",
        );
        expect(calls).toEqual([]);
      });

  it("a workflow ref list of only commas is empty -> 503", async () => {
    const { w, calls } = worker();
    const env = makeEnv({ OIDC_JOB_WORKFLOW_REFS: " , ,," });
    await expectFixed(
      await w.fetch(req("/installs", {}, BEARER), env),
      503,
      "unavailable",
    );
    expect(calls).toEqual([]);
  });

  it("pinsFromEnv trims and drops empty refs", () => {
    expect(
      pinsFromEnv({ ...VARS, OIDC_JOB_WORKFLOW_REFS: ` ${MONITOR} ,, ` })
        ?.jobWorkflowRefs,
    ).toEqual([MONITOR]);
    expect(pinsFromEnv({})).toBeNull();
  });
});

describe("routing after auth", () => {
  it("an authenticated unknown path is a plain 404", async () => {
    const { w } = worker();
    for (const p of [
      "/",
      "/installs/x",
      "/hostsx",
      "/__proto__",
      "/toString",
    ]) {
      const res = await w.fetch(req(p, {}, BEARER), makeEnv());
      expect(res.status, p).toBe(404);
      expect(await res.text()).toBe("Not found");
    }
  });

  it("a wrong method on a known path is 405 with Allow", async () => {
    const { w } = worker();
    for (const [p, m, allow] of [
      ["/installs", "POST", "GET"],
      ["/hosts", "DELETE", "GET"],
      ["/health", "PUT", "GET"],
      ["/prodclean", "GET", "POST"],
    ] as const) {
      const res = await w.fetch(req(p, { method: m }, BEARER), makeEnv());
      expect(res.status, `${m} ${p}`).toBe(405);
      expect(res.headers.get("allow")).toBe(allow);
    }
  });
});

describe("INVENTORY_KEY is gone", () => {
  it("no INVENTORY_KEY, keyMatches or sha256 anywhere in apps/inventory", () => {
    const root = new URL("..", import.meta.url).pathname;
    const self = new URL(import.meta.url).pathname;
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((f) => {
        if (f === "node_modules") return [];
        const p = join(d, f);
        return statSync(p).isDirectory() ? walk(p) : [p];
      });
    for (const f of walk(root)) {
      if (f === self) continue;
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/INVENTORY_KEY|keyMatches|sha256\(/);
    }
  });
});
