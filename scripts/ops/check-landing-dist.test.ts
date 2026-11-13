import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeMain, probeSignup, signupUrlInDist } from "./check-landing-dist";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const script = join(root, "scripts/ops/check-landing-dist.ts");
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "landing-dist-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const put = (rel: string, body: string | Buffer) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
};
const run = (d = dir, extra: string[] = []) => {
  const r = spawnSync("node", [script, d, ...extra], {
    encoding: "utf8",
    env: { ...process.env, HOSTED_SIGNUP_URL: "" },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const SIGNUP = '<a class="btn p" href="https://app.example.com/sign-up">';
const LOGIN =
  '<a class="login" href="https://app.example.com/sign-up">Log in</a>';

// A stubbed fetch that records how it was called. With redirect "follow" the
// real fetch hands back the final response, so the stub does too.
const stub = (status: number) => {
  const calls: { url: string; redirect?: string }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, redirect: init?.redirect });
    return { status };
  }) as unknown as typeof fetch;
  return Object.assign(fn, { calls });
};

describe("probeSignup (release mode)", () => {
  const URL_ = "https://signup.example.com/";
  const detail = async (...a: Parameters<typeof probeSignup>) => {
    const r = await probeSignup(...a);
    return r.live ? null : r.detail;
  };
  it("is live on a final 2xx, and asks fetch to follow redirects", async () => {
    for (const status of [200, 204]) {
      const f = stub(status);
      expect(await probeSignup(URL_, f)).toEqual({ live: true });
      expect(f.calls).toEqual([{ url: URL_, redirect: "follow" }]);
    }
  });
  it("is not live on anything but a final 2xx, and says 'answers <status>'", async () => {
    expect(await detail(URL_, stub(404))).toBe(
      `sign-up URL ${URL_} answers 404`,
    );
    expect(await detail(URL_, stub(503))).toBe(
      `sign-up URL ${URL_} answers 503`,
    );
    // a redirect that was not followed to a 2xx is not good enough
    expect(await detail(URL_, stub(302))).toBe(
      `sign-up URL ${URL_} answers 302`,
    );
  });
  it("is not live when there is no URL or the request throws", async () => {
    expect(await detail(undefined, stub(200))).toContain(
      "no sign-up URL was found in the built home page",
    );
    expect(await detail("  ", stub(200))).toContain("no sign-up URL");
    const boom = (async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;
    expect(await detail(URL_, boom)).toContain("ENOTFOUND");
  });
  describe("probe mode fails the job when sign-ups are closed", () => {
    const page = `<html><head><meta charset="utf-8"></head>${LOGIN}${SIGNUP}Join the waitlist</a>`;
    const probeWith = async (f: typeof fetch) => {
      put("index.html", page);
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((m) => {
        logs.push(String(m));
      });
      try {
        return { code: await probeMain(dir, f), logs };
      } finally {
        spy.mockRestore();
      }
    };
    it("live: exit 0, no error", async () => {
      const r = await probeWith(stub(200));
      expect(r.code).toBe(0);
      expect(r.logs.some((l) => l.startsWith("::error"))).toBe(false);
    });
    it("closed: exit 1 with an annotation naming the URL and the status", async () => {
      const r = await probeWith(stub(404));
      expect(r.code).toBe(1);
      expect(r.logs).toContain(
        "::error::Landing not deployed: sign-up URL https://app.example.com/sign-up answers 404",
      );
    });
    it("unreachable: exit 1", async () => {
      const boom = (async () => {
        throw new Error("ENOTFOUND");
      }) as unknown as typeof fetch;
      const r = await probeWith(boom);
      expect(r.code).toBe(1);
      expect(r.logs.join("\n")).toContain("ENOTFOUND");
    });
  });
  it("probes the URL the built page links to, not the environment", () => {
    put(
      "index.html",
      `<html><head><meta charset="utf-8"></head>${LOGIN}${SIGNUP}Join the waitlist</a>`,
    );
    expect(signupUrlInDist(dir)).toBe("https://app.example.com/sign-up");
    // a dead (#pricing) link is not a sign-up URL
    put(
      "index.html",
      '<a href="#pricing">Join the waitlist</a><a href="https://app.example.com/b">Join the waitlist</a>',
    );
    expect(signupUrlInDist(dir)).toBe("https://app.example.com/b");
    put("index.html", '<a href="#pricing">Join the waitlist</a>');
    expect(signupUrlInDist(dir)).toBeUndefined();
    expect(signupUrlInDist(join(dir, "nope"))).toBeUndefined();
  });
  it("the CLI only probes with --probe-signup, and then fails red with an annotation", () => {
    // no sign-up URL in the page, whatever the environment says
    put("index.html", '<html><head><meta charset="utf-8"></head><p>x</p>');
    const r = run(dir, ["--probe-signup"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      "::error::Landing not deployed: no sign-up URL was found in the built home page",
    );
    // without the flag it is the dist check alone (no probe output)
    const plain = run();
    expect(plain.code).toBe(1);
    expect(plain.out).not.toContain("Landing not deployed");
  });
  it("probe mode still exits 2 when the dist is missing", () => {
    expect(run(join(dir, "nope"), ["--probe-signup"]).code).toBe(2);
  });
});

describe("check-landing-dist", () => {
  it("fails on TODO in html", () => {
    put("index.html", "<p>ok</p>\n<p>TODO fix</p>");
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      `::error file=${join(dir, "index.html")}::landing not release-ready: found "TODO" in ${join(dir, "index.html")}:2`,
    );
    expect(r.out).toContain("::error::Landing deploy skipped:");
  });
  it("fails on TODO in llms.txt", () => {
    put("llms.txt", "# setup\nTODO: instructions");
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("llms.txt:2");
  });
  it("fails on {{ placeholder", () => {
    put("a/b.json", '{"x":"{{ name }}"}');
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain('found "{{"');
  });
  it("fails on OA-UNRELEASED marker and names it", () => {
    put("docs/setup.html", "<p>OA-UNRELEASED</p>");
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain('found "OA-UNRELEASED"');
    expect(r.out).toContain("OA-UNRELEASED");
    expect(r.out).toMatch(/::error::Landing deploy skipped:.*OA-UNRELEASED/);
  });
  it("passes on a clean dir", () => {
    put(
      "index.html",
      `<html><head><meta charset="utf-8"></head><p>hi</p>${LOGIN}${SIGNUP}Join the waitlist</a>`,
    );
    put("llms.txt", "setup");
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out).toContain("ok: landing dist clean");
  });
  const page = (links: string) =>
    `<html><head><meta charset="utf-8"></head><body>\n${links}\n</body></html>`;
  it("fails when a Join the waitlist link goes to #pricing", () => {
    put(
      "index.html",
      page(
        '<a class="btn p" href="https://app.example.com/sign-up">Join the waitlist</a>\n<a class="btn p" href="#pricing">Join the waitlist</a>',
      ),
    );
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("Join the waitlist link without a sign-up URL");
    expect(r.out).toContain("HOSTED_SIGNUP_URL");
    expect(r.out).toContain(`${join(dir, "index.html")}:3`);
    expect(r.out).not.toContain(`${join(dir, "index.html")}:2`);
  });
  it("fails when the home page has no Join the waitlist link at all", () => {
    put("index.html", page('<a href="#self-host">Self-host it</a>'));
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain('no "Join the waitlist" link on the home page');
  });
  it("finds the label inside inner tags, and checks that link too", () => {
    put(
      "index.html",
      page(
        '<a class="btn" href="#pricing"><span>Join the\n waitlist</span></a>',
      ),
    );
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("Join the waitlist link without a sign-up URL");
    expect(r.out).not.toContain('no "Join the waitlist" link');
    put(
      "index.html",
      page(`${LOGIN}${SIGNUP}<span>Join the waitlist</span></a>`),
    );
    expect(run().code).toBe(0);
  });
  it("a Log in link must point at the same sign-up URL as the buttons", () => {
    const buttons = `${SIGNUP}Join the waitlist</a>`;
    put("index.html", page(`<a href="#pricing">Log in</a>${buttons}`));
    let r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      "Log in link that does not point at the sign-up URL",
    );
    put(
      "index.html",
      page(`<a href="https://elsewhere.example.com/">Log in</a>${buttons}`),
    );
    r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      "Log in link that does not point at the sign-up URL",
    );
    put("index.html", page(`<a>Log in</a>${buttons}`));
    expect(run().code).toBe(1);
    put("index.html", page(`${LOGIN}${buttons}`));
    expect(run().code).toBe(0);
  });
  it("fails when the buttons have a sign-up URL but the header has no Log in", () => {
    put("index.html", page(`${SIGNUP}Join the waitlist</a>`));
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain('no "Log in" link in the home page header');
  });
  it("fails when a Join the waitlist link has no href", () => {
    put("index.html", page("<a>Join the waitlist</a>"));
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("Join the waitlist link without a sign-up URL");
  });
  it("passes when every Join the waitlist link goes to the sign-up URL", () => {
    put(
      "index.html",
      page(
        `${LOGIN}<a class="btn" href="https://app.example.com/sign-up">Join the waitlist</a>\n<a href="#pricing">Pricing</a>`,
      ),
    );
    expect(run().code).toBe(0);
  });
  it("fails on a page without a leading utf-8 charset meta", () => {
    put("ok.html", '<head>\n  <meta charset="UTF-8" />\n<title>x</title>');
    put("none.html", "<head><title>x</title></head>");
    put("late.html", '<head><title>x</title><meta charset="utf-8"></head>');
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain(`missing charset`);
    expect(r.out).toContain(`${join(dir, "none.html")}:1`);
    expect(r.out).toContain(`${join(dir, "late.html")}:1`);
    expect(r.out).not.toContain("ok.html");
  });
  it("exits 2 when dist is missing", () => {
    expect(run(join(dir, "nope")).code).toBe(2);
  });
  it("ignores binary files", () => {
    put("img.png", Buffer.from("TODO {{ \0\x01"));
    put("font.woff2", Buffer.from("TODO"));
    expect(run().code).toBe(0);
  });
  it("caps output lines", () => {
    put("x.txt", Array.from({ length: 100 }, () => "TODO").join("\n"));
    const lines = run()
      .out.split("\n")
      .filter((l) => l.startsWith("::error"));
    expect(lines.length).toBeLessThanOrEqual(22);
  });
});
