import { createHash, createPublicKey, verify } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FAKE_AUTHORIZE,
  FAKE_TOKEN,
  type FakeIdp,
  startFakeIdp,
} from "../src/fake-idp/server.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

describe("the fake IdP is trusted by local fake-IdP builds only", () => {
  const SKIP = new Set([
    "node_modules",
    ".git",
    "dist",
    "dist-assets",
    ".wrangler",
    ".turbo",
    ".claude",
    "coverage",
  ]);
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      if (SKIP.has(e.name)) return [];
      const p = join(d, e.name);
      return e.isDirectory() ? walk(p) : e.isFile() ? [p] : [];
    });

  it("no wrangler config under apps/ or packages/ (any depth, jsonc/json/toml) aliases modules or names the shim", () => {
    const configs = ["apps", "packages"]
      .flatMap((r) => walk(join(ROOT, r)))
      .filter((f) => /(^|\/)wrangler[^/]*\.(jsonc|json|toml)$/.test(f));
    expect(configs.length).toBeGreaterThan(3);
    for (const f of configs)
      expect(readFileSync(f, "utf8"), f).not.toMatch(
        /"alias"|\[alias\]|^\s*alias\s*=|fake-idp|auth-core-shim|__OA_FAKE_IDP/m,
      );
  });

  it("nothing outside tests/redline imports, requires or aliases the shim, or reads its defines", () => {
    const own = join(ROOT, "tests", "redline");
    const files = walk(ROOT).filter(
      (f) =>
        !f.startsWith(`${own}/`) &&
        // The release guard names the markers it hunts for.
        !/scripts\/ci\/check-no-fake-idp(\.test)?\.ts$/.test(f) &&
        /\.([cm]?[jt]sx?|jsonc?|toml)$/.test(f),
    );
    expect(files.length).toBeGreaterThan(100);
    const use =
      /(from\s*["'][^"']*auth-core-shim|import\(\s*["'][^"']*auth-core-shim|require\(\s*["'][^"']*auth-core-shim|alias[\s\S]{0,300}auth-core-shim|__OA_FAKE_IDP)/;
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(use);
  });

  it("the shim refuses to load without the build-time defines", async () => {
    // A computed specifier: tsc must not pull the shim (and auth-core's
    // source) into this package's typecheck.
    const shim = join(
      import.meta.dirname,
      "..",
      "src",
      "fake-idp",
      "auth-core-shim.ts",
    );
    await expect(import(shim)).rejects.toThrow(/not a local fake-IdP build/);
  });
});

describe("fake IdP behaviour", () => {
  let idp: FakeIdp;
  afterEach(async () => idp?.stop());
  const CID = "cid.apps.googleusercontent.com";
  const RU = "https://auth.localhost:1/google/callback";
  const verifier = "v".repeat(43);
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  async function code(as: string, hd?: string) {
    const u = new URL(`${idp.origin}${FAKE_AUTHORIZE}`);
    u.search = new URLSearchParams({
      client_id: CID,
      redirect_uri: RU,
      response_type: "code",
      state: "st",
      nonce: "n1",
      code_challenge: challenge,
      code_challenge_method: "S256",
      as,
      ...(hd ? { hd } : {}),
    }).toString();
    const r = await fetch(u, { redirect: "manual" });
    await r.body?.cancel();
    return {
      status: r.status,
      code: new URL(r.headers.get("location") ?? RU).searchParams.get("code"),
    };
  }
  const token = (c: string, v = verifier) =>
    fetch(`${idp.origin}${FAKE_TOKEN}`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: c,
        client_id: CID,
        client_secret: "s",
        redirect_uri: RU,
        code_verifier: v,
      }),
    });

  it("issues a verifiable RS256 token once; refuses reuse, PKCE mismatch, expiry and accounts outside hd", async () => {
    idp = await startFakeIdp({
      clients: { [CID]: { secret: "s", redirectUris: [RU] } },
      users: ["alice@a.test"],
      codeTtlMs: 10_000,
    });
    expect((await code("alice@a.test", "b.test")).status).toBe(403);
    const c1 = (await code("alice@a.test", "a.test")).code as string;
    const r = await token(c1);
    expect(r.status).toBe(200);
    const jwt = ((await r.json()) as { id_token: string }).id_token;
    const [h, p, s] = jwt.split(".") as [string, string, string];
    expect(
      verify(
        "sha256",
        Buffer.from(`${h}.${p}`),
        createPublicKey({ key: idp.publicJwk as never, format: "jwk" }),
        Buffer.from(s, "base64url"),
      ),
    ).toBe(true);
    expect(JSON.parse(Buffer.from(p, "base64url").toString())).toMatchObject({
      iss: "https://accounts.google.com",
      aud: CID,
      hd: "a.test",
      email: "alice@a.test",
      email_verified: true,
      nonce: "n1",
    });
    expect((await token(c1)).status).toBe(400);
    const c2 = (await code("alice@a.test")).code as string;
    expect((await token(c2, "w".repeat(43))).status).toBe(400);
    const c3 = (await code("alice@a.test")).code as string;
    idp.advance(10_001);
    expect((await token(c3)).status).toBe(400);
    expect(idp.events.filter((e) => !e.ok).map((e) => e.why)).toEqual([
      "account_outside_hd",
      "code_reused",
      "pkce_mismatch",
      "code_expired",
    ]);
  });
});
