import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { crossCheck, NotRefused } from "../src/refused.ts";
import {
  codeRequestReq,
  expectStateRefused,
  expectTurnstileRequired,
  labelTurnstileTestKey,
  ownCodeRequestReq,
  signInRefused,
  stateAccepted,
  TURNSTILE_DUMMY_TOKEN,
  TURNSTILE_TEST_KEY,
  tamperInstall,
  usesTurnstileTestKey,
} from "../src/signin.ts";
import { parseTargets, type Target } from "../src/targets.ts";
import { type Fake, fakeServer, secretDir } from "./fake.ts";

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
