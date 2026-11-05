import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { warnings } from "../src/plan.ts";
import { DASH_SENDING } from "../src/steps/email.ts";
import { renderConfig } from "../src/steps/resources.ts";
import { ROOT, STATE } from "./fakes.ts";
import { BASE, HOSTS, onboarded, world } from "./world.ts";

// PR #180 review fixes and rulings.
const CONFIG = join(ROOT, "apps/server/wrangler.jsonc");
const cfg = (w: { files: Map<string, string> }) =>
  JSON.parse(w.files.get(CONFIG) ?? "");
const parse = (w: { lines: string[] }) => w.lines.map((l) => JSON.parse(l));
const line = (w: { lines: string[] }, step: string) =>
  parse(w).find((j) => j.step === step);
const D = "mail.app.example.com";
const PAID = [{ rate_plan: { id: "WORKERS_PAID" }, state: "Paid" }];
const FREE = [{ rate_plan: { id: "free" } }];
const TEAM = [...BASE, "--team", "--yes-paid"];
const CI = [...BASE.filter((a) => a !== "--yes"), "--ci"];
const TEMPLATE = readFileSync(
  join(import.meta.dirname, "../../../apps/server/wrangler.template.jsonc"),
  "utf8",
);

describe("F1: a deploy never silently drops a live binding", () => {
  it("stateless --upgrade of a team install refuses to drop EMAIL", async () => {
    const w = world({ dns: onboarded(D) });
    expect(await run(TEAM, w.deps, ROOT)).toBe(0);
    w.files.delete(STATE);
    w.lines.length = 0;
    expect(await run([...CI, "--upgrade", "--solo"], w.deps, ROOT)).toBe(1);
    const l = parse(w).find((j) => j.status === "error");
    expect(l.step).toBe("deploy");
    expect(l.message).toContain("EMAIL");
    expect(l.message).toContain("--no-email");
    expect(w.ops.filter((o) => o === "deploy")).toHaveLength(1);
    w.lines.length = 0;
    // TEAM passes --yes-paid, which now turns thumbnails on (#20); drop BROWSER too.
    const drop = [
      ...CI,
      "--upgrade",
      "--solo",
      "--no-email",
      "--no-browser",
      "--plan",
      "paid",
    ];
    expect(await run(drop, w.deps, ROOT)).toBe(0);
    expect(cfg(w)).not.toHaveProperty("send_email");
  });

  it("refuses to drop BROWSER and SERVER_THUMBNAILS unless --no-browser", async () => {
    const w = world({ subscriptions: PAID });
    expect(await run([...BASE, "--solo"], w.deps, ROOT)).toBe(0);
    expect(cfg(w).browser).toEqual({ binding: "BROWSER" });
    w.files.delete(STATE);
    w.setSubscriptions(undefined); // stateless CI reads the plan as unknown
    w.lines.length = 0;
    const up = [...CI, "--upgrade", "--solo"];
    expect(await run(up, w.deps, ROOT)).toBe(1);
    const l = parse(w).find((j) => j.status === "error");
    expect(l.message).toContain("BROWSER");
    expect(l.message).toContain("SERVER_THUMBNAILS");
    expect(l.message).toContain("--no-browser");
    expect(
      await run([...up, "--browser", "--plan", "paid"], w.deps, ROOT),
    ).toBe(0);
    expect(cfg(w).browser).toEqual({ binding: "BROWSER" });
    expect(
      await run([...up, "--no-browser", "--plan", "paid"], w.deps, ROOT),
    ).toBe(0);
    expect(cfg(w)).not.toHaveProperty("browser");
  });

  it("a failed bindings read with no saved PLAN refuses a free render", async () => {
    const w = world({ settingsFail: true });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(2);
    expect(line(w, "deploy").status).toBe("action_required");
    expect(line(w, "deploy").message).toContain("--plan");
  });

  it("a failed bindings read still deploys when --plan is explicit", async () => {
    const w = world({ settingsFail: true });
    expect(await run([...HOSTS, "--plan", "free"], w.deps, ROOT)).toBe(0);
    expect(line(w, "deploy").message).toContain("could not read");
  });
});

describe("F2: saved email:true stands in only for an unknown plan", () => {
  it("a detected free plan turns email off despite saved state", async () => {
    const w = world({ dns: onboarded(D), subscriptions: PAID });
    expect(await run([...BASE, "--team"], w.deps, ROOT)).toBe(0);
    w.setSubscriptions([
      { rate_plan: { id: "WORKERS_PAID" }, state: "Cancelled" },
    ]);
    // Free now: email is off, and the live EMAIL binding is not dropped silently.
    expect(await run([...BASE, "--upgrade"], w.deps, ROOT)).toBe(1);
    expect(w.state()).toMatchObject({ plan: "free", email: false });
    // Free also turns thumbnails off: the live BROWSER needs --no-browser too.
    const drop = [
      ...BASE,
      "--upgrade",
      "--no-email",
      "--no-browser",
      "--plan",
      "free",
    ];
    expect(await run(drop, w.deps, ROOT)).toBe(0);
    expect(cfg(w)).not.toHaveProperty("send_email");
  });

  it("saved email:true stands in for an unknown plan", async () => {
    const w = world({ dns: onboarded(D) });
    expect(await run(TEAM, w.deps, ROOT)).toBe(0);
    expect(await run([...BASE, "--upgrade"], w.deps, ROOT)).toBe(0);
    expect(cfg(w).send_email).toEqual([{ name: "EMAIL" }]);
  });
});

describe("F3/F4: the apex always needs the flag and a confirmation", () => {
  const apexDns = [
    { name: "example.com", type: "MX", content: "aspmx.l.google.com" },
    ...onboarded("example.com"),
  ];
  const APEX = [...TEAM, "--email-domain", "example.com"];
  it("F3: onboarded apex with foreign MX still needs confirmation", async () => {
    const w = world({ dns: apexDns });
    expect(await run(APEX, w.deps, ROOT)).toBe(2);
    expect(parse(w).at(-1)).toMatchObject({
      step: "email",
      status: "action_required",
    });
    expect(parse(w).at(-1).message).toContain("--yes-email-domain");
    const y = world({ dns: apexDns });
    expect(await run([...APEX, "--yes-email-domain"], y.deps, ROOT)).toBe(0);
    expect(cfg(y).vars.EMAIL_FROM).toBe("noreply@example.com");
  });
  it("F4: a saved apex is not reused without --email-domain", async () => {
    const w = world({ dns: apexDns });
    expect(await run([...APEX, "--yes-email-domain"], w.deps, ROOT)).toBe(0);
    w.lines.length = 0;
    expect(await run([...BASE, "--upgrade"], w.deps, ROOT)).toBe(2);
    const l = parse(w).at(-1);
    expect(l).toMatchObject({ step: "email", status: "action_required" });
    expect(l.message).toContain("--email-domain example.com");
    expect(w.ops.filter((o) => o === "deploy")).toHaveLength(1);
    // Confirming again needs both flags, every run.
    expect(
      await run(
        [...BASE, "--upgrade", "--email-domain", "example.com"],
        w.deps,
        ROOT,
      ),
    ).toBe(2);
    const again = [
      ...BASE,
      "--upgrade",
      "--email-domain",
      "example.com",
      "--yes-email-domain",
    ];
    expect(await run(again, w.deps, ROOT)).toBe(0);
  });
});

describe("F5: subscriptions paging and a missing state", () => {
  it("follows pagination: WORKERS_PAID on page 2 is paid", async () => {
    const filler = Array.from({ length: 100 }, (_, i) => ({
      rate_plan: { id: `ADDON_${i}` },
      state: "Paid",
    }));
    const w = world({ subscriptions: [...filler, ...PAID] });
    await run(HOSTS, w.deps, ROOT);
    expect(line(w, "prereqs").data.plan).toBe("paid");
  });
  it("WORKERS_PAID without a state is unknown", async () => {
    const w = world({ subscriptions: [{ rate_plan: { id: "WORKERS_PAID" } }] });
    await run(HOSTS, w.deps, ROOT);
    expect(line(w, "prereqs").data.plan).toBe("unknown");
  });
});

describe("F6: no writes to DNS, billing or email", () => {
  it("a full team run makes only GETs on those paths", async () => {
    const w = world({ dns: onboarded(D), subscriptions: PAID });
    const writes: string[] = [];
    const f = w.deps.fetch;
    w.deps.fetch = (async (u: string, i?: RequestInit) => {
      const m = (i?.method ?? "GET").toUpperCase();
      if (
        m !== "GET" &&
        /dns_records|subscriptions|email|dns-query/.test(String(u))
      )
        writes.push(`${m} ${u}`);
      return f(u, i);
    }) as typeof fetch;
    expect(await run([...BASE, "--team"], w.deps, ROOT)).toBe(0);
    expect(writes).toEqual([]);
  });
  it("the fake rejects a DNS write", async () => {
    const w = world();
    const r = await w.deps.fetch(
      "https://api.cloudflare.com/client/v4/zones/z/dns_records",
      { method: "POST", body: "{}" },
    );
    expect(r.status).toBe(405);
  });
  it("interactive apex 'no' stops with no onboarding instructions", async () => {
    const dns = [
      { name: "example.com", type: "MX", content: "aspmx.l.google.com" },
    ];
    const ia = [
      ...BASE.filter((a) => a !== "--yes" && a !== "--json"),
      "--team",
      "--email-domain",
      "example.com",
    ];
    const w = world({ dns, subscriptions: PAID, answers: ["", "n"] });
    expect(await run(ia, w.deps, ROOT)).toBe(2);
    const out = w.lines.join("\n");
    expect(w.lines.at(-1)).toContain("not confirmed");
    expect(out).not.toContain(DASH_SENDING);
    expect(out).not.toContain("cf-bounce._domainkey");
    expect(w.ops).not.toContain("deploy");
  });
});

describe("ruling 1: final warning copy", () => {
  it("is exactly the approved text", () => {
    const msg = Object.fromEntries(
      warnings("unknown").map((x) => [x.code, x.message]),
    );
    expect(msg).toEqual({
      "plan-unknown":
        "Setup couldn't read your Cloudflare plan, so here are the free-plan notes to be safe. If you're on Workers Paid, you can ignore them.",
      "cpu-limit":
        "Cloudflare's free plan gives each request a small amount of processing time, so a very large publish can occasionally fail. Trying again usually works.",
      "kv-writes":
        "The free plan limits how many sign-ins can be saved each day. Connecting many AI agents, or reconnecting them often, can reach that limit until the next day.",
      "no-email":
        "The free plan can't send emails, so teammates won't get invite emails. You can share the invite link yourself.",
      "individual-use":
        "This setup suits one person. For a team, Cloudflare's Workers Paid plan ($5 a month) adds invite emails and more headroom.",
    });
  });
});

describe("ruling 2: thumbnails are Paid-only", () => {
  const thumbs = (w: { files: Map<string, string> }) => {
    const c = cfg(w);
    return { browser: "browser" in c, var: c.vars.SERVER_THUMBNAILS };
  };
  it("paid renders BROWSER and SERVER_THUMBNAILS=on", async () => {
    const w = world({ subscriptions: PAID });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(thumbs(w)).toEqual({ browser: true, var: "on" });
  });
  it("free and unknown render neither", async () => {
    for (const subscriptions of [FREE, undefined]) {
      const w = world({ subscriptions });
      expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
      expect(thumbs(w)).toEqual({ browser: false, var: undefined });
    }
  });
  it("--browser forces both on with a free-plan warning; --no-browser forces off", async () => {
    const w = world({ subscriptions: FREE });
    expect(await run([...HOSTS, "--browser"], w.deps, ROOT)).toBe(0);
    expect(thumbs(w)).toEqual({ browser: true, var: "on" });
    const codes = line(w, "prereqs").data.warnings.map(
      (x: { code: string }) => x.code,
    );
    expect(codes).toContain("browser-free");
    const p = world({ subscriptions: PAID });
    expect(await run([...HOSTS, "--no-browser"], p.deps, ROOT)).toBe(0);
    expect(thumbs(p)).toEqual({ browser: false, var: undefined });
    expect(
      await run([...HOSTS, "--browser", "--no-browser"], p.deps, ROOT),
    ).toBe(1);
  });
  it("saved state decides only when the plan is unknown", async () => {
    const w = world({ subscriptions: PAID });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    w.setSubscriptions(undefined);
    expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).toBe(0);
    expect(thumbs(w)).toEqual({ browser: true, var: "on" });
    w.setSubscriptions(FREE);
    expect(
      await run(
        [...HOSTS, "--upgrade", "--no-browser", "--plan", "free"],
        w.deps,
        ROOT,
      ),
    ).toBe(0);
    expect(thumbs(w)).toEqual({ browser: false, var: undefined });
  });
  it("the template stays strict JSON and both modes parse", () => {
    expect(JSON.parse(TEMPLATE).vars.SERVER_THUMBNAILS).toBe("on");
    const vars = {
      WORKER_NAME: "w",
      APP_HOST: "a.example.com",
      CONTENT_HOST: "c.example.com",
      OWNER_EMAIL: "o@example.com",
      D1_NAME: "d",
      D1_ID: "1",
      R2_BUCKET: "r",
      KV_ID: "k",
      CF_ACCOUNT_ID: "acc",
      ACCESS_TEAM_DOMAIN: "t",
      ACCESS_CLIENT_ID: "i",
    };
    expect(
      JSON.parse(renderConfig(TEMPLATE, vars, false)).vars,
    ).not.toHaveProperty("SERVER_THUMBNAILS");
  });
});

describe("ruling 3: the final state line on normal --json runs", () => {
  it("ends a successful run with plan, team, email, emailDomain, browser", async () => {
    const w = world({ dns: onboarded(D), subscriptions: PAID });
    expect(await run([...BASE, "--team"], w.deps, ROOT)).toBe(0);
    expect(parse(w).at(-1)).toMatchObject({
      step: "state",
      status: "ok",
      data: {
        plan: "paid",
        team: true,
        email: true,
        emailDomain: D,
        browser: true,
      },
    });
  });
});

describe("rule #70: --json never guesses team", () => {
  it("--json, --yes and --ci without --solo/--team or saved state are action_required", async () => {
    for (const argv of [BASE, BASE.filter((a) => a !== "--json"), [...CI]]) {
      const w = world();
      expect(await run(argv, w.deps, ROOT), argv.join(" ")).toBe(2);
      const last = w.lines.at(-1) ?? "";
      expect(last).toContain("Pass --solo or --team");
      expect(last).toContain("prereqs");
      expect(w.ops).toEqual([]);
    }
  });
  it("a saved choice is enough; --check never blocks", async () => {
    const w = world();
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(await run(BASE, w.deps, ROOT)).toBe(0);
    const c = world();
    const check = [...BASE.filter((a) => a !== "--yes"), "--check"];
    expect(await run(check, c.deps, ROOT)).toBe(0);
  });
});

describe("item 44: upgrades keep saved choices", () => {
  it("an --upgrade from v0.2.1 state (no team, no browser) is solo and keeps thumbnails", async () => {
    const w = world({ subscriptions: PAID });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    const {
      team: _t,
      browser: _b,
      email: _e,
      emailDomain: _d,
      plan: _p,
      ...old
    } = w.state();
    // planVar stays: the fake's live Worker has a PLAN var, which v0.2.1 didn't render.
    w.files.set(STATE, `${JSON.stringify(old, null, 2)}\n`);
    w.setSubscriptions(undefined); // wrangler login: the plan reads unknown
    w.lines.length = 0;
    expect(await run([...BASE, "--upgrade"], w.deps, ROOT)).toBe(0);
    expect(w.state()).toMatchObject({ team: false, browser: true });
    expect(cfg(w).browser).toEqual({ binding: "BROWSER" });
  });

  it("a saved --no-email holds on Paid until --team is passed again", async () => {
    const w = world({ subscriptions: PAID });
    expect(await run([...BASE, "--team", "--no-email"], w.deps, ROOT)).toBe(0);
    w.lines.length = 0;
    expect(await run([...BASE, "--upgrade"], w.deps, ROOT)).toBe(0);
    expect(cfg(w)).not.toHaveProperty("send_email");
    expect(w.state()).toMatchObject({ team: true, email: false });
    expect(line(w, "prereqs").data.notes.join("; ")).toContain(
      "rerun with --team to turn invites on",
    );
    // --team again re-decides: Paid turns email on, so the domain is needed.
    expect(await run([...BASE, "--upgrade", "--team"], w.deps, ROOT)).toBe(2);
    expect(parse(w).at(-1)).toMatchObject({ step: "email" });
  });
});
