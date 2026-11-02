import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { auditCheck } from "../src/audit.ts";
import {
  type Cred,
  fromContentApp,
  HttpError,
  hook,
  withCred,
} from "../src/http.ts";
import {
  crossCheck,
  expectRefused,
  NotRefused,
  registerMarker,
} from "../src/refused.ts";
import {
  type Inventory,
  inventoryBearer,
  loadTargets,
  parseTargets,
  type Target,
} from "../src/targets.ts";
import { type Fake, fakeServer, json, secretDir } from "./fake.ts";

/** An inventory OIDC JWT shape (unsigned: only the inventory verifies). */
const INV_JWT = [
  { alg: "RS256" },
  { aud: "https://oa-s-inventory", exp: 4_102_444_800 },
  "sig",
]
  .map((p) =>
    Buffer.from(typeof p === "string" ? p : JSON.stringify(p)).toString(
      "base64url",
    ),
  )
  .join(".");

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

  it("parses inventory and deletedHosts in staging mode; the OIDC JWT stays off the object", async () => {
    const s = secrets({
      k: KEY_A,
      k2: KEY_B,
      inv: INV_JWT,
      REDLINE_STG_INVENTORY_OIDC: INV_JWT,
    });
    const t = (n: string, f: string) => ({
      name: n,
      installId: n,
      app: `https://${n}.x.app`,
      content: `https://${n}.x.page`,
      testDomain: `${n}.test`,
      hookKeyFile: s.path(f),
    });
    const T = parseTargets({
      REDLINE_TARGETS: JSON.stringify({
        a: t("rl-a", "k"),
        b: t("rl-b", "k2"),
        inventory: { url: "https://inv.x.app", oidcFile: s.path("inv") },
        deletedHosts: ["Gone.x.app", "gone.x.page"],
      }),
    });
    expect(T.inventory?.url).toBe("https://inv.x.app");
    expect(T.deletedHosts).toEqual(["Gone.x.app", "gone.x.page"]);
    expect(JSON.stringify(T)).not.toContain(INV_JWT);
    await expect(inventoryBearer(T.inventory as Inventory)).resolves.toBe(
      INV_JWT,
    );
    expect(() =>
      parseTargets({
        REDLINE_TARGETS: JSON.stringify({
          a: t("rl-a", "k"),
          b: t("rl-b", "k2"),
          deletedHosts: [""],
        }),
      }),
    ).toThrow(/deletedHosts/);
    // The CI layout: env URL, JWT file in secretsDir, deleted hosts as JSON.
    const T2 = parseTargets({
      REDLINE_TARGETS: JSON.stringify({
        secretsDir: s.dir,
        a: t("rl-a", "k"),
        b: t("rl-b", "k2"),
      }),
      REDLINE_STG_INVENTORY_URL: "https://inv.x.app",
      REDLINE_DELETED_HOSTS: '["rl-del.x.app"]',
    });
    expect(T2.inventory?.oidcFile).toBe(s.path("REDLINE_STG_INVENTORY_OIDC"));
    expect(T2.deletedHosts).toEqual(["rl-del.x.app"]);
  });

  it("parses strayHost in staging mode only, as a bare host no target owns", () => {
    const s = secrets({ k: KEY_A, k2: KEY_B });
    const t = (n: string, f: string) => ({
      name: n,
      installId: n,
      app: `https://${n}.x.app`,
      content: `https://${n}.x.page`,
      testDomain: `${n}.test`,
      hookKeyFile: s.path(f),
    });
    const parse = (extra: Record<string, unknown>) =>
      parseTargets({
        REDLINE_TARGETS: JSON.stringify({
          a: t("rl-a", "k"),
          b: t("rl-b", "k2"),
          ...extra,
        }),
      });
    expect(parse({ strayHost: "rl-stray.x.app" }).strayHost).toBe(
      "rl-stray.x.app",
    );
    expect(parse({}).strayHost).toBeUndefined();
    for (const bad of [
      "https://rl-stray.x.app",
      "rl-stray.x.app:443",
      "rl-stray.x.app/",
      "RL-STRAY.x.app",
      "stray",
      42,
    ])
      expect(() => parse({ strayHost: bad })).toThrow(/bare hostname/);
    expect(() => parse({ strayHost: "rl-a.x.app" })).toThrow(/own host/);
    expect(() => parse({ strayHost: "rl-b.x.page" })).toThrow(/own host/);
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

describe("guarded JSON (no body text in messages)", () => {
  it("a 200 hook answer that isn't JSON shows status and hash only", async () => {
    const a = await fake((req, res, body) => {
      if (req.url === "/healthz") return healthy("rl-a-id")?.(req, res, body);
      res
        .writeHead(200, { "content-type": "text/plain" })
        .end("SECRET-NOT-JSON");
    });
    const b = await fake(healthy("rl-b-id"));
    const T = await loadTargets(targetsEnv(a, b));
    const err = await hook(T.a, "/__test/session", {}).catch((e: Error) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as Error).message).toMatch(
      /not JSON: status 200, body sha256:/,
    );
    expect((err as Error).message).not.toContain("SECRET-NOT-JSON");
  });
});

describe("fromContentApp", () => {
  it("needs CORP cross-origin and ACAO *", () => {
    const h = (o: Record<string, string>) => new Response("", { headers: o });
    expect(
      fromContentApp(
        h({
          "cross-origin-resource-policy": "cross-origin",
          "access-control-allow-origin": "*",
        }),
      ),
    ).toBe(true);
    expect(fromContentApp(h({ "access-control-allow-origin": "*" }))).toBe(
      false,
    );
    expect(fromContentApp(new Response("", { status: 404 }))).toBe(false);
  });
});

describe("auditCheck (staging path, POST /__test/audit)", () => {
  /** A fake install with the session hook, /api/v1/me and an optional audit hook. */
  const auditInstall = (o: {
    audit: "absent" | "hit" | "miss" | "other-actor";
  }) => {
    let lastUser = "";
    let n = 0;
    let auditBody: unknown = null;
    const handler: Parameters<typeof fakeServer>[0] = (req, res, body) => {
      if (req.url === "/healthz") return healthy("rl-a-id")?.(req, res, body);
      if (req.url === "/__test/session") {
        lastUser = `u${++n}`;
        return json(res, 200, { cookie: `c-${lastUser}` });
      }
      if (req.url === "/api/v1/me") {
        const id = String(req.headers.cookie ?? "").replace(/^.*=c-/, "");
        return json(res, 200, { user: { id, email: "x@oa-redline-a.fyi" } });
      }
      if (req.url === "/__test/audit") {
        auditBody = JSON.parse(body);
        if (o.audit === "absent")
          return json(res, 404, { error: { code: "not_found" } });
        const actorId = o.audit === "other-actor" ? "someone-else" : lastUser;
        const action =
          o.audit === "miss" ? "test_hook.otp_latest" : "test_hook.session";
        return json(res, 200, {
          events: [
            {
              action,
              at: Date.now(),
              actorId,
              targetId: "session",
              detail: {},
            },
          ],
        });
      }
      res.writeHead(404).end();
    };
    return { handler, auditBody: () => auditBody };
  };

  async function run(kind: "absent" | "hit" | "miss" | "other-actor") {
    const f = auditInstall({ audit: kind });
    const a = await fake(f.handler);
    const b = await fake(healthy("rl-b-id"));
    const T = await loadTargets(targetsEnv(a, b));
    // targetsEnv is local mode; drop `local` so the staging (hook) path runs.
    delete (T.a as { local?: unknown }).local;
    return { r: auditCheck(T.a), body: f.auditBody };
  }

  it("the hook absent (404) is unproven-live, never pass", async () => {
    const { r } = await run("absent");
    expect(await r).toEqual({
      level: "unproven-live",
      reason: expect.stringMatching(/404/),
    });
  });

  it("a test_hook.session row for the fresh user is a pass; since is integer ms", async () => {
    const { r, body } = await run("hit");
    expect(await r).toEqual({ level: "pass", via: "hook" });
    const since = (body() as { since: unknown }).since;
    expect(Number.isInteger(since)).toBe(true);
    expect(since as number).toBeGreaterThanOrEqual(0);
  });

  it("no matching row, or a row for another actor, fails", async () => {
    await expect((await run("miss")).r).rejects.toThrow(
      /no test_hook.session audit row/,
    );
    await expect((await run("other-actor")).r).rejects.toThrow(
      /no test_hook.session audit row/,
    );
  });
});
