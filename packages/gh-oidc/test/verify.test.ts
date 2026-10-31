import { beforeAll, describe, expect, it } from "vitest";
import {
  type Claims,
  GITHUB_OIDC_EVENT_NAMES,
  GITHUB_OIDC_ISSUER,
  GITHUB_OIDC_JWKS_URL,
  GITHUB_OIDC_REF,
  JwksCache,
  OidcError,
  type Pins,
  verify,
} from "../src/index.js";

const pins: Pins = {
  audience: "https://api.open-artifacts-staging.app",
  repository: "open-artifacts-ai/open-artifacts",
  repositoryId: "1",
  jobWorkflowRefs: [
    "open-artifacts-ai/open-artifacts/.github/workflows/redline-staging.yml@refs/heads/main",
  ],
  environment: "redline-staging",
};

// Pinned clock: every case runs at T (ms); claims are in seconds.
const T = 1_800_000_000_000;
const S = T / 1000;

const b64u = (b: ArrayBuffer | Uint8Array | string) => {
  const bytes =
    typeof b === "string"
      ? new TextEncoder().encode(b)
      : b instanceof Uint8Array
        ? b
        : new Uint8Array(b);
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

type Key = { priv: CryptoKey; jwk: JsonWebKey & { kid: string } };
const rsa = async (kid: string): Promise<Key> => {
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
  const jwk = await crypto.subtle.exportKey("jwk", k.publicKey);
  return {
    priv: k.privateKey,
    jwk: { kty: jwk.kty, n: jwk.n, e: jwk.e, kid, alg: "RS256", use: "sig" },
  };
};

let key: Key;
let other: Key;
beforeAll(async () => {
  key = await rsa("k1");
  other = await rsa("k2");
});

const good = (): Record<string, unknown> => ({
  iss: GITHUB_OIDC_ISSUER,
  aud: pins.audience,
  sub: `repo:${pins.repository}:environment:${pins.environment}`,
  iat: S - 10,
  nbf: S - 10,
  exp: S + 290,
  repository: pins.repository,
  repository_id: pins.repositoryId,
  ref: GITHUB_OIDC_REF,
  job_workflow_ref: pins.jobWorkflowRefs[0],
  environment: pins.environment,
  event_name: "schedule",
  runner_environment: "github-hosted",
});

async function sign(
  claims: Record<string, unknown>,
  k: Key = key,
  header: Record<string, unknown> = { alg: "RS256", kid: k.jwk.kid },
) {
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    k.priv,
    new TextEncoder().encode(input),
  );
  return `${input}.${b64u(sig)}`;
}

/** A JWKS endpoint that counts calls; `keys` can change between calls. */
function jwksServer(keys: () => JsonWebKey[], ok = true) {
  const s = {
    calls: 0,
    urls: [] as string[],
    fetch: (async (url: string | URL | Request) => {
      s.calls++;
      s.urls.push(String(url));
      if (!ok) throw new Error("network down");
      return new Response(JSON.stringify({ keys: keys() }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  };
  return s;
}

const opts = (srv: ReturnType<typeof jwksServer>, now = T) => ({
  fetch: srv.fetch,
  now: () => now,
  jwks: new JwksCache(),
  cache: null,
});

const codeOf = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(OidcError);
  return (e as OidcError).code;
};

describe("constants", () => {
  it("pins GitHub's issuer and JWKS", () => {
    expect(GITHUB_OIDC_ISSUER).toBe(
      "https://token.actions.githubusercontent.com",
    );
    expect(GITHUB_OIDC_JWKS_URL).toBe(
      "https://token.actions.githubusercontent.com/.well-known/jwks",
    );
  });

  it("fixes ref and event_name in the library, not the caller (4.4)", () => {
    expect(GITHUB_OIDC_REF).toBe("refs/heads/main");
    expect([...GITHUB_OIDC_EVENT_NAMES]).toEqual([
      "schedule",
      "workflow_dispatch",
    ]);
    expect(Object.keys(pins).sort()).toEqual(
      [
        "audience",
        "environment",
        "jobWorkflowRefs",
        "repository",
        "repositoryId",
      ].sort(),
    );
  });
});

describe("verify (4.4)", () => {
  it("accepts a good token and returns its claims", async () => {
    const srv = jwksServer(() => [key.jwk]);
    const c: Claims = await verify(await sign(good()), pins, opts(srv));
    expect(c.repository_id).toBe("1");
    expect(c.event_name).toBe("schedule");
    expect(srv.urls).toEqual([GITHUB_OIDC_JWKS_URL]);
  });

  it("accepts workflow_dispatch", async () => {
    const srv = jwksServer(() => [key.jwk]);
    const c = await verify(
      await sign({ ...good(), event_name: "workflow_dispatch" }),
      pins,
      opts(srv),
    );
    expect(c.event_name).toBe("workflow_dispatch");
  });

  it("refuses malformed input", async () => {
    const srv = jwksServer(() => [key.jwk]);
    for (const jwt of ["", "a.b.c", "not a jwt", "a.b", "....."])
      expect(await codeOf(verify(jwt, pins, opts(srv)))).toBe("malformed");
    expect(srv.calls).toBe(0);
  });

  it("RS256 only: none, HS256 and RS512 are refused before any key fetch", async () => {
    const srv = jwksServer(() => [key.jwk]);
    for (const alg of ["none", "HS256", "RS512", "ES256"])
      expect(
        await codeOf(
          verify(await sign(good(), key, { alg, kid: "k1" }), pins, opts(srv)),
        ),
      ).toBe("alg");
    expect(srv.calls).toBe(0);
  });

  it("refuses a missing kid", async () => {
    const srv = jwksServer(() => [key.jwk]);
    expect(
      await codeOf(
        verify(await sign(good(), key, { alg: "RS256" }), pins, opts(srv)),
      ),
    ).toBe("kid");
  });

  it("refuses a bad signature (right kid, other key)", async () => {
    const srv = jwksServer(() => [key.jwk]);
    expect(
      await codeOf(
        verify(
          await sign(good(), other, { alg: "RS256", kid: "k1" }),
          pins,
          opts(srv),
        ),
      ),
    ).toBe("signature");
  });

  it("refuses a tampered payload", async () => {
    const srv = jwksServer(() => [key.jwk]);
    const [h, , s] = (await sign(good())).split(".");
    const forged = `${h}.${b64u(JSON.stringify({ ...good(), repository_id: "2" }))}.${s}`;
    expect(await codeOf(verify(forged, pins, opts(srv)))).toBe("signature");
  });

  const claimCases: [string, Record<string, unknown>, string][] = [
    ["iss", { iss: "https://evil.example" }, "iss"],
    ["aud", { aud: "https://api.open-artifacts.app" }, "aud"],
    ["aud array", { aud: [pins.audience] }, "aud"],
    ["repository_id", { repository_id: "2" }, "repository_id"],
    ["repository_id number", { repository_id: 1 }, "repository_id"],
    ["repository", { repository: "evil/open-artifacts" }, "repository"],
    ["ref", { ref: "refs/heads/feature" }, "ref"],
    [
      "job_workflow_ref",
      {
        job_workflow_ref:
          "open-artifacts-ai/open-artifacts/.github/workflows/other.yml@refs/heads/main",
      },
      "job_workflow_ref",
    ],
    ["environment", { environment: "production" }, "environment"],
    ["event_name", { event_name: "pull_request" }, "event_name"],
    [
      "runner_environment",
      { runner_environment: "self-hosted" },
      "runner_environment",
    ],
  ];
  for (const [name, patch, code] of claimCases)
    it(`refuses a wrong ${name}`, async () => {
      const srv = jwksServer(() => [key.jwk]);
      expect(
        await codeOf(
          verify(await sign({ ...good(), ...patch }), pins, opts(srv)),
        ),
      ).toBe(code);
    });

  it("accepts any sub (not a 4.4 pin: a custom OIDC sub template still verifies)", async () => {
    const srv = jwksServer(() => [key.jwk]);
    const sub = "repo:open-artifacts-ai/open-artifacts:ref:refs/heads/main";
    await expect(
      verify(await sign({ ...good(), sub }), pins, opts(srv)),
    ).resolves.toMatchObject({ sub });
  });

  it("refuses a token missing any claim", async () => {
    for (const k of Object.keys(good())) {
      const srv = jwksServer(() => [key.jwk]);
      const c = good();
      delete c[k];
      await expect(
        verify(await sign(c), pins, opts(srv)),
        k,
      ).rejects.toBeInstanceOf(OidcError);
    }
  });

  it("exp with 60 s skew", async () => {
    const srv = jwksServer(() => [key.jwk]);
    const c = { ...good(), iat: S - 200, nbf: S - 200, exp: S - 60 };
    await expect(verify(await sign(c), pins, opts(srv))).resolves.toBeTruthy();
    expect(
      await codeOf(verify(await sign({ ...c, exp: S - 61 }), pins, opts(srv))),
    ).toBe("exp");
  });

  it("nbf and iat with 60 s skew", async () => {
    const srv = jwksServer(() => [key.jwk]);
    const c = { ...good(), iat: S + 60, nbf: S + 60, exp: S + 300 };
    await expect(verify(await sign(c), pins, opts(srv))).resolves.toBeTruthy();
    expect(
      await codeOf(verify(await sign({ ...c, nbf: S + 61 }), pins, opts(srv))),
    ).toBe("nbf");
    expect(
      await codeOf(verify(await sign({ ...c, iat: S + 61 }), pins, opts(srv))),
    ).toBe("iat");
  });

  it("exp - iat <= 600", async () => {
    const srv = jwksServer(() => [key.jwk]);
    const c = { ...good(), iat: S - 10, exp: S + 590 };
    await expect(verify(await sign(c), pins, opts(srv))).resolves.toBeTruthy();
    expect(
      await codeOf(verify(await sign({ ...c, exp: S + 591 }), pins, opts(srv))),
    ).toBe("lifetime");
  });

  it("a fetch error fails closed", async () => {
    const srv = jwksServer(() => [key.jwk], false);
    expect(await codeOf(verify(await sign(good()), pins, opts(srv)))).toBe(
      "jwks",
    );
  });

  it("a non-200 or junk JWKS fails closed", async () => {
    for (const res of [
      () => new Response("no", { status: 500 }),
      () => new Response("not json"),
      () => new Response(JSON.stringify({ keys: "x" })),
    ]) {
      const o = {
        ...opts(jwksServer(() => [])),
        fetch: (async () => res()) as typeof fetch,
      };
      expect(await codeOf(verify(await sign(good()), pins, o))).toBe("jwks");
    }
  });
});

describe("JWKS cache (4.4: 10 min; unknown kid refetch once per 60 s)", () => {
  it("reuses the keys within 10 minutes, refetches after", async () => {
    const srv = jwksServer(() => [key.jwk]);
    const jwks = new JwksCache();
    const o = (now: number) => ({
      fetch: srv.fetch,
      now: () => now,
      jwks,
      cache: null,
    });
    const jwt = await sign(good());
    await verify(jwt, pins, o(T));
    await verify(jwt, pins, o(T + 59_999));
    expect(srv.calls).toBe(1);
    const late = await sign({
      ...good(),
      iat: S + 600,
      nbf: S + 600,
      exp: S + 700,
    });
    await verify(late, pins, o(T + 599_999));
    expect(srv.calls).toBe(1);
    await verify(late, pins, o(T + 600_000));
    expect(srv.calls).toBe(2);
  });

  it("an unknown kid refetches at most once per 60 s", async () => {
    let keys = [key.jwk];
    const srv = jwksServer(() => keys);
    const jwks = new JwksCache();
    const o = (now: number) => ({
      fetch: srv.fetch,
      now: () => now,
      jwks,
      cache: null,
    });
    await verify(await sign(good()), pins, o(T));
    expect(srv.calls).toBe(1);
    const rotated = await sign(good(), other);
    // k2 unknown: one refetch, still unknown (GitHub has not published it).
    expect(await codeOf(verify(rotated, pins, o(T + 1000)))).toBe("kid");
    expect(srv.calls).toBe(2);
    // Within 60 s of that refetch: no further fetch.
    expect(await codeOf(verify(rotated, pins, o(T + 60_999)))).toBe("kid");
    expect(srv.calls).toBe(2);
    // GitHub publishes k2; after 60 s the refetch finds it.
    keys = [key.jwk, other.jwk];
    await expect(verify(rotated, pins, o(T + 61_000))).resolves.toBeTruthy();
    expect(srv.calls).toBe(3);
  });

  it("uses the Cache API when given one, and fills it", async () => {
    const store = new Map<string, Response>();
    const url = (r: RequestInfo) => (r instanceof Request ? r.url : String(r));
    const cache = {
      match: async (r: RequestInfo) => store.get(url(r))?.clone(),
      put: async (r: RequestInfo, res: Response) => {
        store.set(url(r), res.clone());
      },
    } as unknown as Cache;
    const srv = jwksServer(() => [key.jwk]);
    const jwt = await sign(good());
    const o = () => ({
      fetch: srv.fetch,
      now: () => T,
      jwks: new JwksCache(),
      cache,
    });
    await verify(jwt, pins, o());
    expect(srv.calls).toBe(1);
    expect(store.get(GITHUB_OIDC_JWKS_URL)?.headers.get("cache-control")).toBe(
      "max-age=600",
    );
    // A fresh isolate (new JwksCache) reads the cached copy, no fetch.
    await verify(jwt, pins, o());
    expect(srv.calls).toBe(1);
  });
});
