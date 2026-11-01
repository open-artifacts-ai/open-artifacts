import { chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HttpError } from "../src/http.ts";
import {
  brokerProbeCheck,
  compareVersions,
  fileChecks,
  formatPreflight,
  gaps,
  networkChecks,
  suiteVersion,
} from "../src/preflight.ts";
import { parseTargets } from "../src/targets.ts";
import { type Fake, fakeServer, json, secretDir } from "./fake.ts";

const dirs: string[] = [];
const fakes: Fake[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const f of fakes.splice(0)) await f.close();
});

const SECRET = "SEKRIT-value-never-printed-0123456789";

describe("preflight file checks (existence and mode only)", () => {
  it("names each gap: PAT files (with the redline-creds command), Turnstile, strayHost; inventory is CI-only", () => {
    const s = secretDir({
      REDLINE_RL_A_PAT: SECRET,
      REDLINE_RL_B_PAT: SECRET,
      ts: SECRET,
    });
    dirs.push(s.dir);
    chmodSync(join(s.dir, "REDLINE_RL_B_PAT"), 0o644);
    const env = {
      REDLINE_TARGETS: JSON.stringify({
        mode: "staging",
        secretsDir: s.dir,
        a: { name: "rl-a", installId: "ia", turnstileFile: join(s.dir, "ts") },
        b: { name: "rl-b", installId: "ib" },
      }),
    };
    const c = fileChecks(env);
    const by = Object.fromEntries(c.map((x) => [x.name, x]));
    expect(by["rl-a PAT file"]?.status).toBe("ok");
    expect(by["rl-b PAT file"]).toMatchObject({
      status: "gap",
      detail: expect.stringMatching(
        /must be mode 0600.*pnpm oa:hosted redline-creds --install ib --confirm ib/,
      ),
    });
    expect(by["rl-a Turnstile token"]?.status).toBe("ok");
    expect(by["rl-b Turnstile token"]).toMatchObject({ status: "gap" });
    expect(by.strayHost).toMatchObject({
      status: "gap",
      detail: expect.stringMatching(
        /REDLINE_TARGETS \(the kit's targets.json\)/,
      ),
    });
    expect(by.inventory).toMatchObject({
      status: "ci-only",
      detail: expect.stringMatching(
        /^CI-only \(not-local\).*never count as a pass/,
      ),
    });
    // CI-only never blocks; gaps do.
    expect(gaps(c).map((x) => x.name)).toEqual([
      "rl-b PAT file",
      "rl-b Turnstile token",
      "strayHost",
    ]);
    const out = formatPreflight(c);
    expect(out).toMatch(/Preflight refused: 3 gaps/);
    expect(out).not.toContain(SECRET);
  });

  it("a missing PAT names the command; a configured inventory with a 0600 OIDC JWT is ok", () => {
    const s = secretDir({ jwt: SECRET, REDLINE_RL_A_PAT: SECRET });
    dirs.push(s.dir);
    const c = fileChecks({
      REDLINE_TARGETS: JSON.stringify({
        secretsDir: s.dir,
        strayHost: "stray.example.test",
        inventory: { url: "https://inv.test", oidcFile: join(s.dir, "jwt") },
        a: { name: "rl-a", installId: "ia" },
        b: { name: "rl-b", installId: "ib" },
      }),
    });
    const by = Object.fromEntries(c.map((x) => [x.name, x]));
    expect(by["rl-b PAT file"]?.detail).toMatch(
      /is missing; run `pnpm oa:hosted redline-creds/,
    );
    expect(by.inventory?.status).toBe("ok");
    expect(by.strayHost?.status).toBe("ok");
  });

  it("versions compare as x.y.z; the suite's version is the repo release", () => {
    expect(compareVersions("0.64.0", "0.64.0")).toBe(0);
    expect(compareVersions("0.63.9", "0.64.0")).toBe(-1);
    expect(compareVersions("1.0.0", "0.64.0")).toBe(1);
    expect(compareVersions("dev", "0.64.0")).toBeNull();
    expect(suiteVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("preflight network checks (read-only)", () => {
  /** A fake install: /healthz, /auth/providers and (optionally) members. */
  async function install(o: {
    version: string;
    google?: string[] | null;
    members?: string[];
  }) {
    const f = await fakeServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      if (u.pathname === "/healthz")
        return json(res, 200, {
          ok: true,
          version: o.version,
          testHooks: true,
          installId: `id-${f.origin}`,
        });
      if (u.pathname === "/auth/providers")
        return json(res, 200, {
          mode: "direct",
          providers: o.google ? [{ id: "google", domains: o.google }] : [],
        });
      if (u.pathname === "/api/v1/members") {
        expect(req.method).toBe("GET");
        return json(
          res,
          200,
          (o.members ?? []).map((email) => ({ email })),
        );
      }
      if (u.pathname === "/auth/login/google")
        return res
          .writeHead(302, {
            location: "https://accounts.google.com/o/oauth2/v2/auth?state=s",
            "set-cookie": "oa_oidc_1=v; Path=/",
          })
          .end();
      res.writeHead(404).end();
    });
    fakes.push(f);
    return f;
  }

  it("names version skew, Google off, TEST_DOMAIN inside AUTH_DOMAINS and uninvited users", async () => {
    const fa = await install({
      version: "0.1.0",
      google: ["oa-redline-a.fyi", "a.test"],
      members: ["alice@oa-redline-a.fyi"],
    });
    const fb = await install({ version: "999.0.0", google: null });
    const s = secretDir({ hk: "k".repeat(40), pat: SECRET });
    dirs.push(s.dir);
    const tgt = (name: string, f: Fake, testDomain: string) => ({
      name,
      installId: `id-${f.origin}`,
      app: f.origin.replace("127.0.0.1", `${name}.localhost`),
      content: `http://${name}.content.localhost:1`,
      testDomain,
      hookKeyFile: join(s.dir, "hk"),
      patFile: join(s.dir, "pat"),
    });
    const T = parseTargets({
      REDLINE_TARGETS: JSON.stringify({
        mode: "local",
        a: tgt("rl-a", fa, "a.test"),
        b: tgt("rl-b", fb, "b.test"),
      }),
    });
    const c = await networkChecks(T, { expectVersion: "0.64.0" });
    const g = Object.fromEntries(gaps(c).map((x) => [x.name, x.detail]));
    expect(g["rl-a version"]).toMatch(
      /0\.1\.0 is older than the suite's 0\.64\.0/,
    );
    expect(g["same version"]).toMatch(/rl-a runs 0\.1\.0, rl-b runs 999\.0\.0/);
    expect(g["rl-b Google sign-in"]).toMatch(/off/);
    expect(g["rl-a TEST_DOMAIN"]).toMatch(/a\.test is in AUTH_DOMAINS/);
    expect(g["rl-b dave (tenant C user)"]).toBe(
      "rl-b: dave (tenant C user) not invited: invite them (Members) first",
    );
    expect(c.find((x) => x.name === "rl-a alice (tenant A user)")?.status).toBe(
      "ok",
    );
    expect(formatPreflight(c)).not.toContain(SECRET);
  });
});

describe("preflight: the install's own path to its broker (POST /__test/broker-probe)", () => {
  const t = {
    name: "rl-a",
    installId: "ia",
    app: "https://rl-a.example.test",
    content: "https://rl-a.content.test",
    testDomain: "a.test",
    cookieName: "__Host-oa_session",
    hookKeyFile: "/dev/null",
  };
  const answer = (v: unknown) => async () => v;
  const http = (status: number) => async (): Promise<unknown> => {
    throw new HttpError("rl-a hook", new Response(null, { status }), "");
  };

  it("green only on the broker's own refusal (401)", async () => {
    expect(
      await brokerProbeCheck(t, { call: answer({ status: 401 }) }),
    ).toEqual({
      name: "rl-a broker from the install",
      status: "ok",
      detail: "the broker refused a junk redeem (401): reachable",
    });
  });

  it("names a 522, a 5xx, a broker 404, a hook error and a timeout", async () => {
    const detail = async (o: Parameters<typeof brokerProbeCheck>[1]) => {
      const c = await brokerProbeCheck(t, o);
      expect(c.status).toBe("gap");
      return c.detail;
    };
    expect(await detail({ call: answer({ status: 522 }) })).toBe(
      "rl-a: install can't reach the auth broker (status 522)",
    );
    expect(await detail({ call: answer({ status: 503 }) })).toMatch(
      /status 503\)$/,
    );
    expect(await detail({ call: answer({ status: 404 }) })).toMatch(
      /status 404\)$/,
    );
    expect(await detail({ call: answer({}) })).toMatch(/status unknown\)$/);
    expect(await detail({ call: http(500) })).toMatch(/status hook 500\)$/);
    expect(
      await detail({ call: () => new Promise(() => {}), timeoutMs: 20 }),
    ).toMatch(/status timeout\)$/);
  });

  it("the hook not deployed (404 on its route) refuses, unless explicitly allowed", async () => {
    const off = await brokerProbeCheck(t, { call: http(404) });
    expect(off).toMatchObject({
      status: "gap",
      detail: expect.stringMatching(
        /^broker reachability from the install: unchecked \(hook not deployed\); upgrade the installs/,
      ),
    });
    // The user's run never gets told how to skip the probe.
    expect((off as { detail: string }).detail).not.toMatch(
      /REDLINE_ALLOW_UNCHECKED_BROKER/,
    );
    const allowed = await brokerProbeCheck(t, {
      call: http(404),
      allowUnchecked: true,
    });
    expect(allowed.status).toBe("unchecked");
    expect(gaps([allowed])).toEqual([]);
    expect(formatPreflight([allowed])).toMatch(
      /SKIP rl-a broker from the install: broker reachability from the install: unchecked/,
    );
  });
});
