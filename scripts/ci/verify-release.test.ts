import { describe, expect, it } from "vitest";
import {
  closeNotLive,
  type Exec,
  reportNotLive,
  verifyRelease,
} from "./verify-release.ts";

const PROD = "https://artifacts.leourbina.com";
const SITE = "https://open-artifacts.com/";
const DEMO = "https://demo.open-artifacts.com";
const page = (
  v: string | undefined,
  attrs = `name="oa-version" content="${v}"`,
) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">${
    v === undefined ? "" : `<meta ${attrs}>`
  }<title>x</title></head><body></body></html>`;

/** A fake internet whose answers can change with the (fake) clock. */
function world(answers: {
  prod?: (t: number) => { status?: number; body?: unknown } | Error;
  site?: (t: number) => { status?: number; body?: string } | Error;
  demo?: (t: number) => { status?: number; body?: unknown } | Error;
}) {
  let t = 0;
  const hits: string[] = [];
  const sleeps: number[] = [];
  const f = async (url: string | URL | Request) => {
    const u = String(url);
    hits.push(u);
    const pick = u.startsWith(PROD)
      ? answers.prod?.(t)
      : u.startsWith(SITE)
        ? answers.site?.(t)
        : u.startsWith(DEMO)
          ? answers.demo?.(t)
          : undefined;
    if (!pick) return new Response("nf", { status: 404 });
    if (pick instanceof Error) throw pick;
    const body =
      typeof pick.body === "string" ? pick.body : JSON.stringify(pick.body);
    return new Response(body, { status: pick.status ?? 200 });
  };
  return {
    hits,
    sleeps,
    deps: {
      fetch: f as typeof fetch,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        t += ms;
      },
      now: () => t,
    },
  };
}
const good = (v: string) => ({
  prod: () => ({ body: { ok: true, version: v } }),
  site: () => ({ body: page(v) }),
});

describe("verifyRelease", () => {
  it("passes when healthz and the landing meta both show the tag's version", async () => {
    const w = world(good("0.5.0"));
    expect(await verifyRelease({ tag: "v0.5.0", ...w.deps })).toEqual({
      ok: true,
      problems: [],
    });
    expect(w.hits).toContain(`${PROD}/healthz`);
    expect(w.hits).toContain(SITE);
  });

  it("skipProd (prod not installed) never touches prod and still checks the landing", async () => {
    const w = world({
      prod: () => new Error("must not be called"),
      site: () => ({ body: page("0.5.0") }),
    });
    expect(
      await verifyRelease({ tag: "v0.5.0", skipProd: true, ...w.deps }),
    ).toEqual({ ok: true, problems: [] });
    expect(w.hits).not.toContain(`${PROD}/healthz`);
    expect(w.hits).toContain(SITE);
  });

  it("skipLanding (deploy-landing did not succeed) never touches the landing and still checks prod", async () => {
    const w = world({
      prod: () => ({ body: { version: "0.5.0" } }),
      site: () => new Error("must not be called"),
    });
    expect(
      await verifyRelease({ tag: "v0.5.0", skipLanding: true, ...w.deps }),
    ).toEqual({ ok: true, problems: [] });
    expect(w.hits).toContain(`${PROD}/healthz`);
    expect(w.hits).not.toContain(SITE);
    // prod is still verified: a wrong prod version still fails
    const bad = world({
      prod: () => ({ body: { version: "0.4.0" } }),
      site: () => new Error("must not be called"),
    });
    const r = await verifyRelease({
      tag: "v0.5.0",
      skipLanding: true,
      timeoutMs: 1,
      ...bad.deps,
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/prod/);
  });

  it("without skipLanding an old landing still fails the check", async () => {
    const w = world({
      prod: () => ({ body: { version: "0.5.0" } }),
      site: () => ({ body: page("0.4.0") }),
    });
    const r = await verifyRelease({ tag: "v0.5.0", timeoutMs: 1, ...w.deps });
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/landing/);
  });

  it("polls healthz until the version arrives (within 3 minutes)", async () => {
    const w = world({
      prod: (t) => ({ body: { version: t >= 60_000 ? "0.5.0" : "0.4.0" } }),
      site: () => ({ body: page("0.5.0") }),
    });
    expect((await verifyRelease({ tag: "v0.5.0", ...w.deps })).ok).toBe(true);
    expect(w.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(60_000);
    expect(w.sleeps.reduce((a, b) => a + b, 0)).toBeLessThan(180_000);
  });

  it("gives up after 3 minutes and names the stale version", async () => {
    const w = world({
      prod: () => ({ body: { version: "0.4.0" } }),
      site: () => ({ body: page("0.5.0") }),
    });
    const r = await verifyRelease({ tag: "v0.5.0", ...w.deps });
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(["prod healthz reports 0.4.0, expected 0.5.0"]);
    const total = w.sleeps.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(180_000);
    expect(total).toBeGreaterThanOrEqual(150_000);
  });

  it("reports an unreachable or non-JSON healthz", async () => {
    for (const prod of [
      () => new Error("fetch failed"),
      () => ({ status: 503, body: "down" }),
      () => ({ body: "<html>login</html>" }),
    ]) {
      const w = world({ prod, site: () => ({ body: page("0.5.0") }) });
      const r = await verifyRelease({
        tag: "v0.5.0",
        ...w.deps,
        timeoutMs: 20_000,
      });
      expect(r.ok).toBe(false);
      expect(r.problems[0]).toMatch(/^prod healthz /);
    }
  });

  it("checks the landing meta equals the version, whatever the attribute order", async () => {
    const w = world({
      prod: () => ({ body: { version: "0.5.0" } }),
      site: () => ({
        body: page("0.5.0", `content="0.5.0" name="oa-version"`),
      }),
    });
    expect((await verifyRelease({ tag: "v0.5.0", ...w.deps })).ok).toBe(true);
  });

  it("flags a stale or missing landing meta", async () => {
    const stale = world({
      prod: () => ({ body: { version: "0.5.0" } }),
      site: () => ({ body: page("0.4.0") }),
    });
    const a = await verifyRelease({
      tag: "v0.5.0",
      ...stale.deps,
      timeoutMs: 20_000,
    });
    expect(a.problems).toEqual(["landing oa-version is 0.4.0, expected 0.5.0"]);
    const none = world({
      prod: () => ({ body: { version: "0.5.0" } }),
      site: () => ({ body: page(undefined) }),
    });
    const b = await verifyRelease({
      tag: "v0.5.0",
      ...none.deps,
      timeoutMs: 20_000,
    });
    expect(b.problems).toEqual(["landing has no oa-version meta tag"]);
  });

  it("reports every problem, not just the first", async () => {
    const w = world({
      prod: () => ({ body: { version: "0.4.0" } }),
      site: () => ({ body: page("0.4.0") }),
    });
    const r = await verifyRelease({
      tag: "v0.5.0",
      ...w.deps,
      timeoutMs: 20_000,
    });
    expect(r.problems).toHaveLength(2);
  });

  it("also checks the demo instance when a demo url is given", async () => {
    const ok = world({
      ...good("0.5.0"),
      demo: () => ({ body: { version: "0.5.0" } }),
    });
    expect(
      (await verifyRelease({ tag: "v0.5.0", demoUrl: DEMO, ...ok.deps })).ok,
    ).toBe(true);
    expect(ok.hits).toContain(`${DEMO}/healthz`);
    const bad = world({
      ...good("0.5.0"),
      demo: () => ({ body: { version: "0.4.0" } }),
    });
    const r = await verifyRelease({
      tag: "v0.5.0",
      demoUrl: DEMO,
      ...bad.deps,
      timeoutMs: 20_000,
    });
    expect(r.problems).toEqual(["demo healthz reports 0.4.0, expected 0.5.0"]);
  });

  it("does not touch the demo when no demo url is given", async () => {
    const w = world(good("0.5.0"));
    await verifyRelease({ tag: "v0.5.0", ...w.deps });
    expect(w.hits.some((h) => h.startsWith(DEMO))).toBe(false);
  });

  it("rejects a tag that isn't vX.Y.Z", async () => {
    const w = world(good("0.5.0"));
    await expect(verifyRelease({ tag: "latest", ...w.deps })).rejects.toThrow(
      /tag/,
    );
  });
});

describe("verifyRelease hardening", () => {
  it("accepts pre-release tags like v0.5.0-rc.1 without throwing", async () => {
    const w = world(good("0.5.0-rc.1"));
    expect((await verifyRelease({ tag: "v0.5.0-rc.1", ...w.deps })).ok).toBe(
      true,
    );
  });

  it("still rejects tags that are not semver", async () => {
    const w = world(good("0.5.0"));
    for (const tag of ["0.5.0", "v1", "v1.2.3 x", "v1.2.3-"])
      await expect(verifyRelease({ tag, ...w.deps })).rejects.toThrow(/tag/);
  });

  it("never echoes remote text that is not a semver into a problem", async () => {
    const evil = "0.4.0`\n@everyone [x](http://evil)";
    const w = world({
      prod: () => ({ body: { version: evil } }),
      site: () => ({ body: page(evil) }),
    });
    const r = await verifyRelease({
      tag: "v0.5.0",
      ...w.deps,
      timeoutMs: 20_000,
    });
    expect(r.problems.join(" ")).not.toMatch(/evil|everyone|`/);
    expect(r.problems).toHaveLength(2);
  });

  it("does not echo a fetch error message", async () => {
    const w = world({
      prod: () => new Error("boom @everyone"),
      site: () => ({ body: page("0.5.0") }),
    });
    const r = await verifyRelease({
      tag: "v0.5.0",
      ...w.deps,
      timeoutMs: 20_000,
    });
    expect(r.problems.join(" ")).not.toContain("everyone");
  });
});

describe("closeNotLive", () => {
  const REPO = "open-artifacts-ai/open-artifacts";
  it("closes 'not live' issues for this or an older tag, with a comment, and leaves newer and other issues", async () => {
    const calls: string[][] = [];
    const issues = [
      { number: 1, title: "Release v0.4.0 not live: prod healthz unreachable" },
      {
        number: 2,
        title: "Release v0.5.0 not live: landing has no oa-version meta tag",
      },
      { number: 3, title: "Release v0.6.0 not live: x" },
      { number: 4, title: "Release blocked: checks failing" },
      { number: 5, title: "Release vevil not live: x" },
    ];
    const exec: Exec = (cmd, args) => {
      calls.push([cmd, ...args]);
      return {
        code: 0,
        stdout:
          args[0] === "issue" && args[1] === "list"
            ? JSON.stringify(issues)
            : "",
        stderr: "",
      };
    };
    expect(await closeNotLive({ exec, repo: REPO, tag: "v0.5.0" })).toEqual([
      1, 2,
    ]);
    const closes = calls.filter((c) => c[1] === "issue" && c[2] === "close");
    expect(closes.map((c) => c[3])).toEqual(["1", "2"]);
    expect(closes[0]?.[closes[0].indexOf("--comment") + 1]).toContain("v0.5.0");
  });
});

describe("reportNotLive", () => {
  it("builds the title only from safe characters", async () => {
    const calls: string[][] = [];
    const exec: Exec = (cmd, args) => {
      calls.push([cmd, ...args]);
      return { code: 0, stdout: args[1] === "list" ? "[]" : "", stderr: "" };
    };
    await reportNotLive({
      exec,
      repo: "o/r",
      tag: "v0.5.0",
      problems: ["bad `x` @everyone\nnewline [l](http://e)"],
    });
    const create =
      calls.find((c) => c[2] === "create" && c[1] === "issue") ?? [];
    expect(create[create.indexOf("--title") + 1]).toMatch(/^[\w .,;:()'?-]+$/);
  });

  it("refuses a tag that is not semver", async () => {
    const exec: Exec = () => ({ code: 0, stdout: "[]", stderr: "" });
    await expect(
      reportNotLive({ exec, repo: "o/r", tag: "v1 @x", problems: ["x"] }),
    ).rejects.toThrow(/tag/);
  });
});

describe("reportNotLive (issues)", () => {
  const REPO = "open-artifacts-ai/open-artifacts";
  const fakeExec = (existing: { number: number; title: string }[] = []) => {
    const calls: string[][] = [];
    const exec: Exec = (cmd, args) => {
      calls.push([cmd, ...args]);
      const out =
        args[0] === "issue" && args[1] === "list"
          ? JSON.stringify(existing)
          : "";
      return { code: 0, stdout: out, stderr: "" };
    };
    return { exec, calls };
  };

  it("opens a blocker issue 'Release vX.Y.Z not live: <what>'", async () => {
    const f = fakeExec();
    await reportNotLive({
      exec: f.exec,
      repo: REPO,
      tag: "v0.5.0",
      problems: [
        "prod healthz reports 0.4.0, expected 0.5.0",
        "landing has no oa-version meta tag",
      ],
    });
    const create =
      f.calls.find((c) => c[1] === "issue" && c[2] === "create") ?? [];
    expect(create[create.indexOf("--title") + 1]).toBe(
      "Release v0.5.0 not live: prod healthz reports 0.4.0, expected 0.5.0; landing has no oa-version meta tag",
    );
    expect(create[create.indexOf("--label") + 1]).toBe("blocker");
    expect(create[create.indexOf("--body") + 1]).toContain(
      "landing has no oa-version meta tag",
    );
  });

  it("comments instead of opening a duplicate for the same release", async () => {
    const f = fakeExec([
      { number: 12, title: "Release v0.5.0 not live: something older" },
    ]);
    await reportNotLive({
      exec: f.exec,
      repo: REPO,
      tag: "v0.5.0",
      problems: ["x"],
    });
    expect(f.calls.some((c) => c[1] === "issue" && c[2] === "create")).toBe(
      false,
    );
    const comment =
      f.calls.find((c) => c[1] === "issue" && c[2] === "comment") ?? [];
    expect(comment[3]).toBe("12");
  });
});
