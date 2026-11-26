import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/index.ts";
import { PROBES } from "../src/steps/prereqs.ts";
import {
  renderTokenPage,
  serveTokenPage,
  TEMPLATE_PATH,
} from "../src/token-page.ts";
import {
  linkFor,
  tokenById,
  tokens,
  tokenUrl,
  withUrls,
} from "../src/tokens.ts";
import { core, ROOT, STATE } from "./fakes.ts";
import { HOSTS, world } from "./world.ts";

type W = ReturnType<typeof world>;
const parsed = (w: { lines: string[] }) => w.lines.map((l) => JSON.parse(l));
const line = (w: W, step: string) => parsed(w).find((j) => j.step === step);
const interactive = HOSTS.filter((a) => a !== "--yes" && a !== "--json");
const ACC = "26ac346086d4405f7a976d48747a2a75";

describe("token table", () => {
  it("lists deploy, access, analytics in order; plain words, no em dashes", () => {
    const t = tokens();
    expect(t.map((x) => x.id)).toEqual(["deploy", "access", "analytics"]);
    expect(t.map((x) => x.required)).toEqual([true, true, false]);
    for (const x of t) {
      expect(x.purpose + x.next + x.name).not.toMatch(/[–—]/);
      expect(x.permissions.length).toBeGreaterThan(0);
      for (const p of x.permissions) {
        expect(p.key).toMatch(/^[a-z0-9_]+$/);
        expect(["read", "edit"]).toContain(p.type);
        expect(p.label).toMatch(/: (Read|Edit)$/);
      }
    }
    expect(tokenById("analytics").permissions).toEqual([
      {
        key: "account_analytics",
        type: "read",
        label: "Account Analytics: Read",
      },
    ]);
  });
  it("stores as env vars, or as gh secrets with --repo", () => {
    expect(tokens().map((t) => t.storeAs)).toEqual([
      {
        kind: "env",
        name: "CLOUDFLARE_API_TOKEN",
        command: expect.any(String),
      },
      { kind: "env", name: "OA_ACCESS_TOKEN", command: expect.any(String) },
      { kind: "env", name: "ANALYTICS_TOKEN", command: expect.any(String) },
    ]);
    expect(tokens({ repo: "me/oa" })[2]?.storeAs).toEqual({
      kind: "gh-secret",
      name: "ANALYTICS_TOKEN",
      command: "gh secret set ANALYTICS_TOKEN -R me/oa",
    });
  });
  it("tokenUrl encodes the permission keys and omits unknown params", () => {
    const perms = [{ key: "dns", type: "read" as const }];
    const keys = encodeURIComponent('[{"key":"dns","type":"read"}]');
    const base = "https://dash.cloudflare.com/profile/api-tokens";
    expect(tokenUrl(perms)).toBe(`${base}?permissionGroupKeys=${keys}`);
    expect(
      tokenUrl(perms, { accountId: "a1", zoneId: "z1", name: "x y" }),
    ).toBe(
      `${base}?permissionGroupKeys=${keys}&accountId=a1&zoneId=z1&name=x%20y`,
    );
    // Labels never leak into the link.
    expect(tokenUrl(tokenById("access").permissions)).not.toContain("label");
  });
  it("only tokens with zone permissions carry the zone id", () => {
    const ids = { accountId: "a1", zones: [{ id: "z1", name: "example.com" }] };
    expect(linkFor(tokenById("deploy"), ids)).toContain("zoneId=z1");
    // Access needs no zone permission (no Access call touches DNS).
    expect(linkFor(tokenById("access"), ids)).not.toContain("zoneId");
    expect(linkFor(tokenById("analytics"), ids)).not.toContain("zoneId");
  });
});

describe("table and setup checks never drift", () => {
  it("every table permission has a prereqs probe, and every probe a permission", () => {
    const table = new Set(
      tokens().flatMap((t) => t.permissions.map((p) => `${p.key}:${p.type}`)),
    );
    expect(new Set(Object.keys(PROBES))).toEqual(table);
  });
  it("the access step's link is the table's access link", async () => {
    const w = world({ org: "forbidden" });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(2);
    const last = parsed(w).at(-1);
    expect(JSON.stringify(last)).toContain(
      linkFor(tokenById("access"), { accountId: "acc1" }),
    );
  });
  it("the ANALYTICS_TOKEN prompt link is the table's analytics link", async () => {
    const w = world({ answers: [""] });
    await run(interactive, w.deps, ROOT);
    const q = w.prompts.find((p) => p.includes("ANALYTICS_TOKEN")) ?? "";
    expect(q).toContain(linkFor(tokenById("analytics"), { accountId: "acc1" }));
  });
  it("setup's access source has no hand-written permission keys", () => {
    const src = readFileSync(
      join(import.meta.dirname, "../src/steps/access.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/key: "access/);
    expect(src).not.toContain("permissionGroupKeys");
  });
});

describe("prereqs token report", () => {
  it("a missing token is reported with its link (json data and message)", async () => {
    const w = world();
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    const pre = line(w, "prereqs");
    const a = pre.data.tokens.find((t: { id: string }) => t.id === "analytics");
    expect(a).toMatchObject({
      status: "missing",
      env: "ANALYTICS_TOKEN",
      required: false,
    });
    expect(a.url).toBe(
      linkFor(tokenById("analytics"), {
        accountId: "acc1",
        zones: [{ id: "z", name: "example.com" }],
      }),
    );
    // first run (no saved state): the optional token's link is also a note, never in the message
    expect(pre.data.notes.join("; ")).toContain(a.url);
    expect(pre.message).toBe("prerequisites ok");
  });
  it("a token that gets 403 on a probe lacks that permission", async () => {
    const w = world({ org: "forbidden" });
    w.deps.env.CLOUDFLARE_API_TOKEN = "t";
    w.deps.env.ANALYTICS_TOKEN = "an";
    await run(HOSTS, w.deps, ROOT);
    const pre = line(w, "prereqs");
    const deploy = pre.data.tokens.find(
      (t: { id: string }) => t.id === "deploy",
    );
    // world: no subscriptions -> 403 on Billing, an optional permission.
    expect(deploy).toMatchObject({
      status: "optional",
      missing: [],
      optional: ["Billing: Read (optional, lets setup detect your plan)"],
    });
    const access = pre.data.tokens.find(
      (t: { id: string }) => t.id === "access",
    );
    expect(access).toMatchObject({
      status: "lacks",
      missing: ["Access: Organizations: Read"],
    });
    expect(
      pre.data.tokens.some((t: { id: string }) => t.id === "analytics"),
    ).toBe(false);
  });
  it("human output carries the link too", async () => {
    const w = world();
    await run(
      HOSTS.filter((a) => a !== "--json"),
      w.deps,
      ROOT,
    );
    const pre = w.lines.find((l) => l.includes("prereqs:")) ?? "";
    expect(pre).toContain(
      linkFor(tokenById("analytics"), {
        accountId: "acc1",
        zones: [{ id: "z", name: "example.com" }],
      }),
    );
  });
});

describe("--token-links", () => {
  it("--json prints one ok line with every token and its link", async () => {
    const c = core();
    expect(
      await run(["--token-links", "--json", "--account-id", ACC], c.deps, ROOT),
    ).toBe(0);
    expect(c.lines).toHaveLength(1);
    const j = JSON.parse(c.lines[0] as string);
    expect(j).toEqual({
      step: "token-links",
      status: "ok",
      data: { tokens: withUrls(tokens(), { accountId: ACC }) },
    });
  });
  it("fills the account from state and the zone from the app host", async () => {
    const w = world({
      state: { name: "oa", accountId: "acc1", appHost: "app.example.com" },
    });
    expect(await run(["--token-links", "--json"], w.deps, ROOT)).toBe(0);
    const j = JSON.parse(w.lines.at(-1) as string);
    expect(j.data.tokens.map((t: { url: string }) => t.url)).toEqual(
      withUrls(tokens({ name: "oa" }), {
        accountId: "acc1",
        zones: [{ id: "z", name: "example.com" }],
      }).map((t) => t.url),
    );
    expect(w.ops).toEqual([]);
  });
  it("human output names each token, its permissions and link", async () => {
    const c = core();
    expect(await run(["--token-links"], c.deps, ROOT)).toBe(0);
    const out = c.lines.join("\n");
    for (const t of withUrls(tokens())) {
      expect(out).toContain(t.name);
      expect(out).toContain(t.url);
      for (const p of t.permissions) expect(out).toContain(p.label);
    }
    expect(out).toContain("read -rsp");
  });
  it("is listed in --help", async () => {
    const c = core();
    await run(["--help"], c.deps, ROOT);
    for (const f of ["--token-links", "--token-page", "--no-open", "--repo"])
      expect(c.lines.join("\n")).toContain(f);
  });
});

describe("--token-page", () => {
  const template = readFileSync(TEMPLATE_PATH, "utf8");
  const linked = withUrls(tokens(), {
    accountId: ACC,
    zones: [{ id: "z1", name: "example.com" }],
  });
  const html = renderTokenPage(linked, template);
  const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

  it("renders exactly one card and one progress item per token", () => {
    expect(count(html, /<section class="token"/g)).toBe(linked.length);
    const progress = html.split('<ol class="progress">')[1]?.split("</ol>")[0];
    expect(count(progress ?? "", /<li>/g)).toBe(linked.length);
    for (const [i, t] of linked.entries()) {
      expect(html).toContain(`id="token-${t.id}"`);
      expect(html).toContain(`Token ${i + 1} of ${linked.length}`);
    }
    expect(html).not.toMatch(/\{\{\w+\}\}/);
  });
  it("every link equals the --token-links output", async () => {
    const c = core();
    await run(["--token-links", "--json", "--account-id", ACC], c.deps, ROOT);
    const urls = JSON.parse(c.lines[0] as string).data.tokens.map(
      (t: { url: string }) => t.url,
    );
    const page = renderTokenPage(
      withUrls(tokens(), { accountId: ACC }),
      template,
    );
    const hrefs = [...page.matchAll(/class="go" href="([^"]+)"/g)].map((m) =>
      (m[1] as string).replaceAll("&amp;", "&"),
    );
    expect(hrefs).toEqual(urls);
  });
  it("has no inputs, one script, no external requests", () => {
    expect(html).not.toMatch(/<input|<textarea|<form/i);
    expect(count(html, /<script/g)).toBe(1);
    expect(html).not.toMatch(/<(link|img|iframe)\b|src=|@import|url\(/i);
  });
  it("escapes every value", () => {
    const evil = withUrls(tokens({ name: '<b>"x"&' }));
    const page = renderTokenPage(evil, template);
    expect(page).not.toContain('<b>"x"');
    expect(page).toContain("&lt;b&gt;&quot;x&quot;&amp;");
  });
  it("store lines follow storeAs; optional tokens say so", () => {
    expect(html).toContain(
      "read -rsp &quot;Cloudflare deploy token (hidden, then Enter): &quot; T",
    );
    expect(html).toMatch(
      /Token 3 of 3 · about 1 minute · read-only · optional/,
    );
    expect(html).toContain("Analytics token <span>optional</span>");
    const gh = renderTokenPage(withUrls(tokens({ repo: "me/oa" })), template);
    expect(gh).toContain("gh secret set OA_ACCESS_TOKEN -R me/oa");
  });

  describe("server", () => {
    afterEach(() => vi.useRealTimers());
    it("binds 127.0.0.1 on a random port and serves the page", async () => {
      const s = await serveTokenPage(html, { idleMs: 60_000 });
      try {
        const addr = s.server.address() as { address: string; port: number };
        expect(addr.address).toBe("127.0.0.1");
        expect(addr.port).toBeGreaterThan(0);
        expect(s.url).toBe(`http://127.0.0.1:${addr.port}/`);
        const res = await fetch(s.url);
        expect(res.headers.get("content-type")).toContain("text/html");
        expect(await res.text()).toBe(html);
      } finally {
        s.close();
      }
      await s.closed;
    });
    it("closes after the idle timeout", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const s = await serveTokenPage(html, { idleMs: 30 * 60_000 });
      let done = false;
      void s.closed.then(() => {
        done = true;
      });
      vi.advanceTimersByTime(30 * 60_000 - 1);
      await Promise.resolve();
      expect(done).toBe(false);
      vi.advanceTimersByTime(1);
      await s.closed;
      expect(s.server.listening).toBe(false);
    });
    it("run --token-page --no-open --json prints tokenPage.url and opens nothing", async () => {
      const c = core();
      const opened: string[] = [];
      c.deps.exec = async (cmd, args) => {
        opened.push(`${cmd} ${args.join(" ")}`);
        return { code: 0, stdout: "", stderr: "" };
      };
      let stop: (() => void) | undefined;
      c.deps.onSignal = (_sig, h) => {
        stop = h;
        return () => {};
      };
      const p = run(["--token-page", "--no-open", "--json"], c.deps, ROOT);
      await c.printed; // the first line is out
      const j = JSON.parse(c.lines[0] as string);
      expect(j).toMatchObject({ step: "token-page", status: "ok" });
      expect(j.data.tokenPage.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      const page = await (await fetch(j.data.tokenPage.url)).text();
      expect(page).toContain(withUrls(tokens())[0]?.name);
      stop?.();
      expect(await p).toBe(0);
      expect(opened).toEqual([]);
    });
  });
});

it("state file is untouched by token commands", async () => {
  const c = core({ files: { [STATE]: '{"name":"oa"}' } });
  await run(["--token-links", "--json"], c.deps, ROOT);
  expect(c.files.get(STATE)).toBe('{"name":"oa"}');
});

describe("#18/#19: the prereqs report", () => {
  const prereqs = (w: ReturnType<typeof world>) => line(w, "prereqs");
  it("#18: status ok, a fixed message, warnings only in data.warnings, notes in data.notes", async () => {
    const w = world({ subscriptions: [{ rate_plan: { id: "free" } }] });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    const l = prereqs(w);
    expect(l.status).toBe("ok");
    expect(l.message).toBe("prerequisites ok");
    expect(l.data.warnings.length).toBeGreaterThan(0);
    expect(l.data.notes ?? []).not.toEqual(
      expect.arrayContaining(
        l.data.warnings.map((x: { message: string }) => x.message),
      ),
    );
  });
  it("#18: a rerun is also ok, never skipped", async () => {
    const w = world();
    await run(HOSTS, w.deps, ROOT);
    w.lines.length = 0;
    await run(HOSTS, w.deps, ROOT);
    expect(prereqs(w).status).toBe("ok");
  });
  it("#19: the optional analytics link is a note only on the first run; data.tokens always has it", async () => {
    const w = world();
    await run(HOSTS, w.deps, ROOT);
    const first = prereqs(w);
    const url = first.data.tokens.find(
      (t: { id: string }) => t.id === "analytics",
    ).url;
    expect(first.data.notes.join("; ")).toContain(url);
    w.lines.length = 0;
    await run(HOSTS, w.deps, ROOT);
    const again = prereqs(w);
    expect((again.data.notes ?? []).join("; ")).not.toContain(url);
    expect(
      again.data.tokens.find((t: { id: string }) => t.id === "analytics").url,
    ).toBe(url);
    expect(again.message).toBe("prerequisites ok");
  });
  it("#18: --check prints prereqs data (warnings, notes, tokens)", async () => {
    const w = world({ subscriptions: [{ rate_plan: { id: "free" } }] });
    await run(HOSTS, w.deps, ROOT);
    w.lines.length = 0;
    const check = [...HOSTS.filter((a) => a !== "--yes"), "--check"];
    await run(check, w.deps, ROOT);
    const l = prereqs(w);
    expect(l.data.warnings.length).toBeGreaterThan(0);
    expect(l.data.tokens.length).toBeGreaterThan(0);
    expect(l.message).toBe("done");
  });
});
