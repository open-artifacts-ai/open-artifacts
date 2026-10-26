import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { crossCheck, NotRefused } from "../src/refused.ts";
import {
  CAPTURE_FLOWS,
  CALLBACK_GOOGLE,
  expectStateRefused,
  parseCaptures,
  signInRefused,
  stateAccepted,
  tamperInstall,
} from "../src/signin.ts";
import type { Target } from "../src/targets.ts";
import { type Fake, fakeServer } from "./fake.ts";

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
    expect(stateAccepted(redirect(`${B.app}/sign-in?error=failed&next=%2F`), B)).toBe(true);
    expect(stateAccepted(redirect("/sign-in?error=failed"), B)).toBe(true);
    expect(stateAccepted(redirect(`${A.app}/sign-in?error=failed`), B)).toBe(false);
    expect(
      stateAccepted(
        redirect(`${B.app}/sign-in?error=failed`, ["__Host-oa_session=x; Path=/"]),
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
      signInRefused("tenant")(redirect(`${B.app}/`, ["__Host-oa_session=x"]), B),
    ).rejects.toThrow(NotRefused);
  });
});

describe("tamperInstall", () => {
  it("swaps the install id and keeps the signature", () => {
    const p = Buffer.from(JSON.stringify({ i: "rl-a-id", s: "x", h: "y" })).toString("base64url");
    const out = tamperInstall(`${p}.SIG`, "rl-b-id");
    const [q, sig] = out.split(".");
    expect(sig).toBe("SIG");
    expect(JSON.parse(Buffer.from(q as string, "base64url").toString())).toEqual({
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

describe("parseCaptures", () => {
  const started = Date.now();
  function capDir(over: { url?: (flow: string, state: string) => string; mode?: number; age?: number } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "oa-redline-cap-"));
    dirs.push(dir);
    const flows = Object.entries(CAPTURE_FLOWS).map(([flow, s]) => ({
      flow,
      at: s.at,
      state: `st-${flow}`,
      cookie: { name: "__Host-oa_oidc_x", value: "v" },
      startedAt: started - (over.age ?? 0),
    }));
    writeFileSync(join(dir, "flows.json"), JSON.stringify(flows), { mode: 0o600 });
    for (const f of flows) {
      const app = f.at === "a" ? A.app : B.app;
      writeFileSync(
        join(dir, `${f.flow}.url`),
        over.url?.(f.flow, f.state) ??
          `${app}${CALLBACK_GOOGLE}?code=c-${f.flow}&state=${f.state}&bstate=bs`,
        { mode: over.mode ?? 0o600 },
      );
    }
    return dir;
  }

  it("reads every flow", () => {
    const m = parseCaptures(capDir(), { a: A, b: B }, started);
    expect(m.size).toBe(Object.keys(CAPTURE_FLOWS).length);
    expect(m.get("b-alice")?.query).toEqual({ state: "st-b-alice", code: "c-b-alice", bstate: "bs" });
  });

  it("refuses stale captures, another start's state, another host, no code and loose modes", () => {
    const T = { a: A, b: B };
    expect(() => parseCaptures(capDir({ age: 10 * 60_000 }), T, started)).toThrow(/older/);
    expect(() =>
      parseCaptures(capDir({ url: () => `${A.app}${CALLBACK_GOOGLE}?code=x&state=other` }), T, started),
    ).toThrow();
    expect(() =>
      parseCaptures(capDir({ url: (_f, s) => `https://evil.test${CALLBACK_GOOGLE}?code=x&state=${s}` }), T, started),
    ).toThrow(/callback/);
    expect(() =>
      parseCaptures(
        capDir({ url: (f, s) => `${CAPTURE_FLOWS[f as keyof typeof CAPTURE_FLOWS].at === "a" ? A.app : B.app}${CALLBACK_GOOGLE}?error=access_denied&state=${s}` }),
        T,
        started,
      ),
    ).toThrow(/no code/);
    expect(() => parseCaptures(capDir({ mode: 0o644 }), T, started)).toThrow(/0600/);
  });
});
