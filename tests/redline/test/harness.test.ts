import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { type Cred, HttpError, hook, withCred } from "../src/http.ts";
import {
  crossCheck,
  expectRefused,
  NotRefused,
  registerMarker,
} from "../src/refused.ts";
import {
  loadTargets,
  parseTargets,
  prodClean,
  type Target,
} from "../src/targets.ts";
import { type Fake, fakeServer, json, secretDir } from "./fake.ts";

const KEY_A = "a".repeat(40);
const KEY_B = "b".repeat(40);
const toDispose: (() => unknown)[] = [];
afterEach(async () => {
  for (const d of toDispose.splice(0)) await d();
});

async function fake(h?: Parameters<typeof fakeServer>[0]): Promise<Fake> {
  const f = await fakeServer(h);
  toDispose.push(() => f.close());
  return f;
}

function secrets(files: Record<string, string>) {
  const s = secretDir(files);
  toDispose.push(s.cleanup);
  return s;
}

/** REDLINE_TARGETS for two fakes, local mode. */
function targetsEnv(a: Fake, b: Fake, extra: Record<string, unknown> = {}) {
  const s = secrets({ "a-key": KEY_A, "b-key": KEY_B });
  const t = (name: string, f: Fake, file: string, domain: string) => ({
    name,
    installId: `${name}-id`,
    app: f.origin,
    content: `http://${name}.content.localhost:1`,
    testDomain: domain,
    hookKeyFile: s.path(file),
  });
  return {
    REDLINE_TARGETS: JSON.stringify({
      mode: "local",
      a: t("rl-a", a, "a-key", "oa-redline-a.fyi"),
      b: t("rl-b", b, "b-key", "oa-redline-c.fyi"),
      ...extra,
    }),
  };
}

const healthy = (installId: string, testHooks = true) =>
  ((req, res) => {
    if (req.url === "/healthz")
      return json(res, 200, {
        ok: true,
        plan: "free",
        version: "x",
        ...(testHooks ? { testHooks: true } : {}),
        installId,
      });
    res.writeHead(404).end();
  }) as Parameters<typeof fakeServer>[0];

/** A fake install answering /api/v1/me 200 only for `token`, 401 otherwise. */
const install = (installId: string, token: string) =>
  ((req, res, body) => {
    if (req.url === "/healthz") return healthy(installId)?.(req, res, body);
    if (req.headers.authorization === `Bearer ${token}`)
      return json(res, 200, { email: "x" });
    json(res, 401, { error: { code: "unauthorized" } });
  }) as Parameters<typeof fakeServer>[0];

const B: Target = {
  name: "rl-b",
  installId: "rl-b-id",
  app: "https://rl-b.example.test",
  content: "https://rl-b.example-content.test",
  testDomain: "oa-redline-c.fyi",
  cookieName: "__Host-oa_session",
  hookKeyFile: "/dev/null",
};

describe("expectRefused", () => {
  it("rejects a 200", async () => {
    await expect(
      expectRefused(new Response("{}", { status: 200 }), B),
    ).rejects.toThrow(NotRefused);
  });

  it("rejects a 302 that sets a cookie", async () => {
    const res = new Response(null, {
      status: 302,
      headers: {
        location: `${B.app}/sign-in`,
        "set-cookie": "__Host-oa_session=abc; Path=/",
      },
    });
    await expect(expectRefused(res, B)).rejects.toThrow(/sets a cookie/);
  });

  it("rejects a 302 that isn't to B's own sign-in", async () => {
    const res = new Response(null, {
      status: 302,
      headers: { location: "https://elsewhere.test/sign-in" },
    });
    await expect(expectRefused(res, B)).rejects.toThrow(/sign-in/);
  });

  it("accepts a 302 to B's own sign-in with no cookie", async () => {
    const res = new Response(null, {
      status: 302,
      headers: { location: "/sign-in" },
    });
    await expect(expectRefused(res, B)).resolves.toBeUndefined();
  });

  it("rejects a 403 whose body contains B's marker", async () => {
    const marker = "REDLINE-rl-b-unit403marker";
    registerMarker(B, marker);
    const res = new Response(
      JSON.stringify({ error: "forbidden", title: marker }),
      { status: 403 },
    );
    const err = await expectRefused(res, B).catch((e: Error) => e);
    expect(err).toBeInstanceOf(NotRefused);
    // The message names status and hash, never the body.
    expect(String((err as Error).message)).not.toContain(marker);
  });

  it("rejects a 401 that sets a session cookie", async () => {
    const res = new Response("", {
      status: 401,
      headers: { "set-cookie": "oa_session=v; Path=/" },
    });
    await expect(expectRefused(res, B)).rejects.toThrow(/session cookie/);
  });

  it("accepts a bare 401", async () => {
    await expect(
      expectRefused(new Response("", { status: 401 }), B),
    ).resolves.toBeUndefined();
  });
});

describe("crossCheck", () => {
  const me = (cred: Cred, t: Target) =>
    new Request(`${t.app}/api/v1/me`, withCred(cred));
  const pat = (token: string): Cred => ({ kind: "pat", token });

  it("passes when each install accepts only its own credential", async () => {
    const a = await fake(install("rl-a-id", "ta"));
    const b = await fake(install("rl-b-id", "tb"));
    const T = await loadTargets(targetsEnv(a, b));
    await expect(
      crossCheck(me, { a: T.a, b: T.b, credA: pat("ta"), credB: pat("tb") }),
    ).resolves.toBeUndefined();
  });

  it("fails when B's own credential is refused (a B that 401s everything)", async () => {
    const a = await fake(install("rl-a-id", "ta"));
    const b = await fake(install("rl-b-id", "nothing-matches"));
    const T = await loadTargets(targetsEnv(a, b));
    await expect(
      crossCheck(me, { a: T.a, b: T.b, credA: pat("ta"), credB: pat("tb") }),
    ).rejects.toThrow(/B's own credential failed at B/);
  });

  it("fails when A's credential is refused at A", async () => {
    const a = await fake(install("rl-a-id", "nothing-matches"));
    const b = await fake(install("rl-b-id", "tb"));
    const T = await loadTargets(targetsEnv(a, b));
    await expect(
      crossCheck(me, { a: T.a, b: T.b, credA: pat("ta"), credB: pat("tb") }),
    ).rejects.toThrow(/A's credential failed at A/);
  });

  it("fails when B accepts A's credential", async () => {
    const a = await fake(install("rl-a-id", "shared"));
    const b = await fake(install("rl-b-id", "shared"));
    const T = await loadTargets(targetsEnv(a, b));
    await expect(
      crossCheck(me, {
        a: T.a,
        b: T.b,
        credA: pat("shared"),
        credB: pat("shared"),
      }),
    ).rejects.toThrow(NotRefused);
  });

  it("never follows a redirect (redirect: manual)", async () => {
    let followed = false;
    const a = await fake(install("rl-a-id", "ta"));
    const b = await fake((req, res, body) => {
      if (req.url === "/healthz") return healthy("rl-b-id")?.(req, res, body);
      if (req.url === "/landed") {
        followed = true;
        return json(res, 200, {});
      }
      if (req.headers.authorization === "Bearer tb") return json(res, 200, {});
      res.writeHead(302, { location: "/landed" }).end();
    });
    const T = await loadTargets(targetsEnv(a, b));
    await expect(
      crossCheck(me, { a: T.a, b: T.b, credA: pat("ta"), credB: pat("tb") }),
    ).rejects.toThrow(/redirect not to B's own sign-in/);
    expect(followed).toBe(false);
  });
});

describe("prodClean", () => {
  /** A fake inventory + CF API + healthz in one server. */
  async function prod(
    o: {
      secretNames?: string[];
      bindings?: string[];
      testHooks?: boolean;
      rowHooks?: boolean;
    } = {},
  ) {
    const f = await fake((req, res) => {
      const u = req.url ?? "";
      if (u === "/installs") {
        if (
          req.headers.authorization !==
          "Bearer inv-key-0123456789abcdef0123456789"
        )
          return res.writeHead(404).end();
        return json(res, 200, {
          installs: [
            {
              id: "acme",
              appHost: "acme.example",
              contentHost: "c",
              state: "live",
              testHooks: o.rowHooks ?? false,
            },
          ],
        });
      }
      if (u === "/healthz")
        return json(res, 200, {
          ok: true,
          installId: "acme",
          ...(o.testHooks ? { testHooks: true } : {}),
        });
      if (
        u.endsWith(
          "/workers/dispatch/namespaces/oa-prod/scripts/oa-p-acme/secrets",
        )
      )
        return json(res, 200, {
          result: (o.secretNames ?? ["SESSION_SECRET"]).map((name) => ({
            name,
            type: "secret_text",
          })),
        });
      if (
        u.endsWith(
          "/workers/dispatch/namespaces/oa-prod/scripts/oa-p-acme/settings",
        )
      )
        return json(res, 200, {
          result: {
            bindings: (o.bindings ?? ["DB"]).map((name) => ({ name })),
          },
        });
      res.writeHead(404).end();
    });
    const s = secrets({
      inv: "inv-key-0123456789abcdef0123456789",
      tok: "scripts-token",
    });
    const a = await fake(healthy("rl-a-id"));
    const b = await fake(healthy("rl-b-id"));
    const env = targetsEnv(a, b);
    const raw = JSON.parse(env.REDLINE_TARGETS);
    raw.mode = "staging";
    for (const k of ["a", "b"]) {
      raw[k].app = `https://${raw[k].name}.example`;
      raw[k].content = `https://${raw[k].name}.example-content`;
    }
    raw.prod = {
      inventoryUrl: "https://inventory.example",
      inventoryKeyFile: s.path("inv"),
      scriptsTokenFile: s.path("tok"),
      accountId: "acct",
      apiBase: `${f.origin}/client/v4`,
    };
    const T = parseTargets({ REDLINE_TARGETS: JSON.stringify(raw) });
    // The fake answers inventory, healthz and the API on one origin.
    return {
      T,
      run: () =>
        prodClean(T.prod as NonNullable<typeof T.prod>, {
          appOrigin: () => f.origin,
        }),
      f,
    };
  }

  it("passes on a clean prod", async () => {
    const p = await prod();
    // inventoryUrl must be https in the JSON; point it at the fake after parsing.
    Object.assign(p.T.prod as object, { inventoryUrl: p.f.origin });
    await expect(p.run()).resolves.toEqual({ installs: 1 });
  });

  it("fails on a prod script that lists TEST_HOOK_KEY", async () => {
    const p = await prod({ secretNames: ["SESSION_SECRET", "TEST_HOOK_KEY"] });
    Object.assign(p.T.prod as object, { inventoryUrl: p.f.origin });
    await expect(p.run()).rejects.toThrow(/lists TEST_HOOK_KEY/);
  });

  it("fails on a prod script whose settings bind TEST_HOOKS", async () => {
    const p = await prod({ bindings: ["DB", "TEST_HOOKS"] });
    Object.assign(p.T.prod as object, { inventoryUrl: p.f.origin });
    await expect(p.run()).rejects.toThrow(/lists TEST_HOOKS/);
  });

  it("fails on healthz testHooks: true", async () => {
    const p = await prod({ testHooks: true });
    Object.assign(p.T.prod as object, { inventoryUrl: p.f.origin });
    await expect(p.run()).rejects.toThrow(/testHooks is true/);
  });

  it("fails on an inventory row with testHooks", async () => {
    const p = await prod({ rowHooks: true });
    Object.assign(p.T.prod as object, { inventoryUrl: p.f.origin });
    await expect(p.run()).rejects.toThrow(/inventory testHooks is not false/);
  });
});

describe("loadTargets", () => {
  it("refuses a target without testHooks", async () => {
    const a = await fake(healthy("rl-a-id"));
    const b = await fake(healthy("rl-b-id", false));
    await expect(loadTargets(targetsEnv(a, b))).rejects.toThrow(
      /rl-b \/healthz: testHooks is not true/,
    );
  });

  it("refuses a target reporting another installId", async () => {
    const a = await fake(healthy("rl-a-id"));
    const b = await fake(healthy("rl-a-id"));
    await expect(loadTargets(targetsEnv(a, b))).rejects.toThrow(/installId/);
  });

  it("accepts the CI layout (secretsDir with REDLINE_<NAME>_HOOK_KEY and _PAT)", () => {
    const s = secrets({
      REDLINE_RL_A_HOOK_KEY: KEY_A,
      REDLINE_RL_A_PAT: "oa_pat_a",
      REDLINE_RL_B_HOOK_KEY: KEY_B,
      REDLINE_RL_B_PAT: "oa_pat_b",
    });
    const t = (n: string, d: string) => ({
      name: n,
      installId: n,
      app: `https://${n}.open-artifacts-staging.app`,
      content: `https://${n}.open-artifacts-staging.page`,
      testDomain: d,
    });
    const T = parseTargets({
      REDLINE_TARGETS: JSON.stringify({
        secretsDir: s.dir,
        a: t("rl-a", "oa-redline-a.fyi"),
        b: t("rl-b", "oa-redline-c.fyi"),
      }),
    });
    expect(T.mode).toBe("staging");
    expect(T.a.hookKeyFile).toBe(s.path("REDLINE_RL_A_HOOK_KEY"));
    expect(T.b.patFile).toBe(s.path("REDLINE_RL_B_PAT"));
    expect(T.a.cookieName).toBe("__Host-oa_session");
    // Secrets never ride on the Target.
    expect(JSON.stringify(T)).not.toContain(KEY_A);
    expect(JSON.stringify(T)).not.toContain("oa_pat_a");
  });

  it("refuses a key file readable by others", () => {
    const s = secretDir({});
    toDispose.push(s.cleanup);
    writeFileSync(s.path("k"), KEY_A, { mode: 0o644 });
    writeFileSync(s.path("k2"), KEY_B, { mode: 0o600 });
    const env = {
      REDLINE_TARGETS: JSON.stringify({
        mode: "local",
        a: {
          name: "rl-a",
          installId: "a",
          app: "http://a.localhost:1",
          content: "http://ac.localhost:1",
          testDomain: "a.test",
          hookKeyFile: s.path("k"),
        },
        b: {
          name: "rl-b",
          installId: "b",
          app: "http://b.localhost:1",
          content: "http://bc.localhost:1",
          testDomain: "b.test",
          hookKeyFile: s.path("k2"),
        },
      }),
    };
    expect(() => parseTargets(env)).toThrow(/0600/);
  });

  it("refuses a hook key under 32 chars, and http targets in staging mode", () => {
    const s = secrets({ k: "short", k2: KEY_B, k3: KEY_A });
    const t = (n: string, f: string, app = `https://${n}.x.app`) => ({
      name: n,
      installId: n,
      app,
      content: `https://${n}.x.page`,
      testDomain: `${n}.test`,
      hookKeyFile: s.path(f),
    });
    expect(() =>
      parseTargets({
        REDLINE_TARGETS: JSON.stringify({
          a: t("rl-a", "k"),
          b: t("rl-b", "k2"),
        }),
      }),
    ).toThrow(/32/);
    expect(() =>
      parseTargets({
        REDLINE_TARGETS: JSON.stringify({
          a: t("rl-a", "k3", "http://rl-a.x.app"),
          b: t("rl-b", "k2"),
        }),
      }),
    ).toThrow(/https/);
  });
});

describe("hook()", () => {
  it("sends the bearer key; a failure shows status and body hash, never the body", async () => {
    let auth = "";
    const a = await fake((req, res, body) => {
      if (req.url === "/healthz") return healthy("rl-a-id")?.(req, res, body);
      auth = String(req.headers.authorization);
      json(res, 404, { secret: "BODY-SECRET-VALUE" });
    });
    const b = await fake(healthy("rl-b-id"));
    const T = await loadTargets(targetsEnv(a, b));
    const err = await hook(T.a, "/__test/session", {}).catch((e: Error) => e);
    expect(auth).toBe(`Bearer ${KEY_A}`);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as Error).message).toMatch(
      /status 404, body sha256:[0-9a-f]{16}/,
    );
    expect((err as Error).message).not.toContain("BODY-SECRET-VALUE");
    expect((err as Error).message).not.toContain(KEY_A);
  });

  it("withCred always sets redirect: manual", () => {
    expect(withCred({ kind: "none" }, { redirect: "follow" }).redirect).toBe(
      "manual",
    );
  });
});
