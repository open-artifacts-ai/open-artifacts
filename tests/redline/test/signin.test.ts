import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { HookError, HttpError } from "../src/http.ts";
import { crossCheck, NotRefused } from "../src/refused.ts";
import {
  codeRequestReq,
  expectStateRefused,
  expectTurnstileRequired,
  labelTurnstileTestKey,
  ownCodeRequestReq,
  pendingCode,
  signInRefused,
  stateAccepted,
  TURNSTILE_DUMMY_TOKEN,
  TURNSTILE_TEST_KEY,
  tamperInstall,
  usesTurnstileTestKey,
} from "../src/signin.ts";
import { loadTargets, parseTargets, type Target } from "../src/targets.ts";
import { type Fake, fakeServer, json, secretDir } from "./fake.ts";

const t = (name: string, app: string): Target => ({
  name,
  installId: `${name}-id`,
  app,
  content: `https://${name}.content.test`,
  testDomain: `${name}.test`,
  cookieName: "__Host-oa_session",
  hookKeyFile: "/dev/null",
});
const A = t("rl-a", "https://rl-a.example.test");
const B = t("rl-b", "https://rl-b.example.test");

const redirect = (location: string, cookies: string[] = []) => {
  const h = new Headers({ location });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(null, { status: 302, headers: h });
};

const dirs: string[] = [];
const fakes: Fake[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const f of fakes.splice(0)) await f.close();
});

describe("state checks", () => {
  it("stateAccepted: B's own /sign-in?error=failed without a session", () => {
    expect(
      stateAccepted(redirect(`${B.app}/sign-in?error=failed&next=%2F`), B),
    ).toBe(true);
    expect(stateAccepted(redirect("/sign-in?error=failed"), B)).toBe(true);
    expect(stateAccepted(redirect(`${A.app}/sign-in?error=failed`), B)).toBe(
      false,
    );
    expect(
      stateAccepted(
        redirect(`${B.app}/sign-in?error=failed`, [
          "__Host-oa_session=x; Path=/",
        ]),
        B,
      ),
    ).toBe(false);
  });

  it("expectStateRefused accepts B's retry login and the expired page", async () => {
    await expectStateRefused(
      redirect(`${B.app}/auth/login/google?next=%2F&retry=1`, [
        "__Host-oa_oidc_abcdefghij=; Max-Age=0",
      ]),
      B,
    );
    await expectStateRefused(redirect(`${B.app}/sign-in?error=expired`), B);
  });

  it("expectStateRefused rejects error=failed (B accepted A's state), a session, another origin and a 200", async () => {
    for (const r of [
      redirect(`${B.app}/sign-in?error=failed`),
      redirect(`${B.app}/auth/login/google?retry=1`, ["__Host-oa_session=x"]),
      redirect(`${A.app}/auth/login/google?retry=1`),
      new Response("ok", { status: 200 }),
    ])
      await expect(expectStateRefused(r, B)).rejects.toThrow(NotRefused);
  });

  it("signInRefused: only the listed errors, never a session", async () => {
    await signInRefused("tenant")(redirect(`${B.app}/sign-in?error=tenant`), B);
    await expect(
      signInRefused("tenant")(redirect(`${B.app}/sign-in?error=failed`), B),
    ).rejects.toThrow(NotRefused);
    await expect(
      signInRefused("tenant")(
        redirect(`${B.app}/`, ["__Host-oa_session=x"]),
        B,
      ),
    ).rejects.toThrow(NotRefused);
  });
});

describe("tamperInstall", () => {
  it("swaps the install id and keeps the signature", () => {
    const p = Buffer.from(
      JSON.stringify({ i: "rl-a-id", s: "x", h: "y" }),
    ).toString("base64url");
    const out = tamperInstall(`${p}.SIG`, "rl-b-id");
    const [q, sig] = out.split(".");
    expect(sig).toBe("SIG");
    expect(
      JSON.parse(Buffer.from(q as string, "base64url").toString()),
    ).toEqual({
      i: "rl-b-id",
      s: "x",
      h: "y",
    });
  });
});

describe("crossCheck refuseFirst", () => {
  it("refuses A's at B before A's success (single-use credentials)", async () => {
    const order: string[] = [];
    const f = await fakeServer((req, res) => {
      order.push(String(req.url));
      res.writeHead(req.url === "/b/A" ? 401 : 200).end();
    });
    fakes.push(f);
    const fa = t("rl-a", `${f.origin}`);
    const fb = { ...t("rl-b", f.origin), app: `${f.origin}` };
    await crossCheck<string>(
      (c, host) => new Request(`${f.origin}/${host === fa ? "a" : "b"}/${c}`),
      { a: fa, b: fb, credA: "A", credB: "B", refuseFirst: true },
    );
    expect(order).toEqual(["/b/B", "/b/A", "/a/A"]);
  });
});

describe("Turnstile test key label", () => {
  const targetsWith = (tokA?: string, tokB?: string) => {
    const s = secretDir({
      key: "k".repeat(40),
      ...(tokA ? { "a-ts": tokA } : {}),
      ...(tokB ? { "b-ts": tokB } : {}),
    });
    dirs.push(s.dir);
    const tgt = (name: string, tsFile?: string) => ({
      name,
      installId: `${name}-id`,
      app: `http://${name}.app.localhost:1`,
      content: `http://${name}.content.localhost:1`,
      testDomain: `${name}.test`,
      hookKeyFile: s.path("key"),
      ...(tsFile ? { turnstileFile: s.path(tsFile) } : {}),
    });
    return parseTargets({
      REDLINE_TARGETS: JSON.stringify({
        mode: "local",
        a: tgt("rl-a", tokA ? "a-ts" : undefined),
        b: tgt("rl-b", tokB ? "b-ts" : undefined),
      }),
    });
  };
  const ctx = () => ({ task: { meta: {} as { redlineLabel?: string } } });

  it("the dummy token on either target labels the case", () => {
    expect(TURNSTILE_TEST_KEY).toBe("Turnstile test key");
    for (const [a, b] of [
      [TURNSTILE_DUMMY_TOKEN, TURNSTILE_DUMMY_TOKEN],
      [TURNSTILE_DUMMY_TOKEN, undefined],
      [undefined, TURNSTILE_DUMMY_TOKEN],
    ] as const) {
      const T = targetsWith(a, b);
      const c = ctx();
      labelTurnstileTestKey(c, [T.a, T.b]);
      expect(c.task.meta.redlineLabel).toBe("Turnstile test key");
    }
  });

  it("ownCodeRequestReq sends the target's token, and none without one", async () => {
    const T = targetsWith(TURNSTILE_DUMMY_TOKEN, undefined);
    expect(await ownCodeRequestReq(T.a, "x@rl-a.test").json()).toEqual({
      email: "x@rl-a.test",
      turnstileToken: TURNSTILE_DUMMY_TOKEN,
    });
    expect(await ownCodeRequestReq(T.b, "x@rl-b.test").json()).toEqual({
      email: "x@rl-b.test",
    });
  });

  it("a real token, or none, leaves the case unlabeled", () => {
    for (const [a, b] of [
      ["0.real-token", "0.real-token"],
      [undefined, undefined],
    ] as const) {
      const T = targetsWith(a, b);
      const c = ctx();
      labelTurnstileTestKey(c, [T.a, T.b]);
      expect(c.task.meta.redlineLabel).toBeUndefined();
      expect(usesTurnstileTestKey(T.a)).toBe(false);
    }
  });
});

describe("expectTurnstileRequired", () => {
  const err = (status: number, code: string) =>
    new Response(JSON.stringify({ error: { code, message: "m" } }), {
      status,
      headers: { "content-type": "application/json" },
    });

  it("passes only on 400 turnstile_required", async () => {
    await expect(
      expectTurnstileRequired(A, err(400, "turnstile_required")),
    ).resolves.toBeUndefined();
    for (const r of [
      new Response("{}", { status: 202 }),
      err(403, "turnstile_failed"),
      err(400, "bad_request"),
      err(503, "code_unavailable"),
      new Response("not json", { status: 400 }),
    ])
      await expect(expectTurnstileRequired(A, r)).rejects.toThrow(
        /rl-a code request without a Turnstile token: status \d+, body sha256:[0-9a-f]{16}/,
      );
  });

  it("the request carries no turnstileToken", async () => {
    const req = codeRequestReq(A, "x@rl-a.test");
    expect(req.method).toBe("POST");
    expect(new URL(req.url).pathname).toBe("/auth/code/request");
    expect(await req.json()).toEqual({ email: "x@rl-a.test" });
  });
});

describe("pendingCode (the __Host- cookie case's code)", () => {
  /** rl-a on a fake whose otp/latest hook answers with `h`. */
  async function hooked(h: NonNullable<Parameters<typeof fakeServer>[0]>) {
    // loadTargets checks each install's /healthz (testHooks, installId).
    const withHealthz =
      (id: string, next?: typeof h): typeof h =>
      (q, r, b) =>
        q.url === "/healthz"
          ? json(r, 200, { ok: true, testHooks: true, installId: id })
          : next
            ? next(q, r, b)
            : r.writeHead(404).end();
    const f = await fakeServer(withHealthz("rl-a-id", h));
    fakes.push(f);
    const other = await fakeServer(withHealthz("rl-b-id"));
    fakes.push(other);
    const s = secretDir({ k: "k".repeat(40) });
    dirs.push(s.dir);
    const tg = (name: string, o: Fake) => ({
      name,
      installId: `${name}-id`,
      app: o.origin,
      content: `http://${name}.content.localhost:1`,
      testDomain: `${name}.test`,
      hookKeyFile: s.path("k"),
    });
    const T = await loadTargets({
      REDLINE_TARGETS: JSON.stringify({
        mode: "local",
        a: tg("rl-a", f),
        b: tg("rl-b", other),
      }),
    });
    return T.a;
  }
  const ok = { status: 202, pending: ["oa_code=x"] };
  const NO_CODE = {
    error: {
      code: "not_found",
      message: "Not found",
      details: { reason: "no_code" },
    },
  };

  it("no pending cookie: unproven with why, no hook call", async () => {
    let calls = 0;
    const t = await hooked((_q, r) => {
      calls++;
      r.writeHead(500).end();
    });
    expect(
      await pendingCode(t, "g@rl-a.test", { status: 202, pending: [] }),
    ).toEqual({
      unproven:
        "rl-a: code sign-in unavailable (no pending code cookie; request status 202)",
    });
    expect(
      await pendingCode(t, "g@rl-a.test", { status: 429, pending: ["x=1"] }),
    ).toEqual({
      unproven:
        "rl-a: code sign-in unavailable (no pending code cookie; request status 429)",
    });
    expect(calls).toBe(0);
  });

  it("only no_code 404s within the wait: unproven, no code within the wait", async () => {
    let calls = 0;
    const t = await hooked((_q, r) => {
      calls++;
      json(r, 404, NO_CODE);
    });
    expect(await pendingCode(t, "g@rl-a.test", ok, 600)).toEqual({
      unproven: "rl-a: code sign-in unavailable (no code within 0.6 s)",
    });
    expect(calls).toBeGreaterThan(1);
  });

  it("a reasonless 404 (rate limited, wrong key, hooks off) throws at once with status and body hash", async () => {
    let calls = 0;
    const t = await hooked((_q, r) => {
      calls++;
      json(r, 404, { error: { code: "not_found", message: "Not found" } });
    });
    const e = await pendingCode(t, "g@rl-a.test", ok).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HookError);
    expect((e as HookError).reason).toBe("no_reason");
    expect((e as Error).message).toMatch(
      /^rl-a hook \/__test\/otp\/latest \(no_reason\): status 404, body sha256:[0-9a-f]{16} /,
    );
    expect(calls).toBe(1);
  });

  it("a 404 with another reason throws too (bad_input is not no code)", async () => {
    const t = await hooked((_q, r) =>
      json(r, 404, { error: { details: { reason: "bad_input" } } }),
    );
    await expect(pendingCode(t, "g@rl-a.test", ok)).rejects.toThrow(
      /\(bad_input\): status 404/,
    );
  });

  it("any other status fails with it", async () => {
    const t = await hooked((_q, r) => r.writeHead(500).end());
    const e = await pendingCode(t, "g@rl-a.test", ok).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(500);
    expect((e as Error).message).toMatch(/status 500/);
  });

  it("the code once the hook has it", async () => {
    let n = 0;
    const t = await hooked((_q, r) =>
      ++n < 2 ? json(r, 404, NO_CODE) : json(r, 200, { code: "123456" }),
    );
    expect(await pendingCode(t, "g@rl-a.test", ok)).toEqual({ code: "123456" });
  });
});
