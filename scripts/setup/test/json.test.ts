import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { ROOT, STATE } from "./fakes.ts";
import { HOSTS, world } from "./world.ts";

type W = ReturnType<typeof world>;
const parsed = (w: W) => w.lines.map((l) => JSON.parse(l));
const last = (w: W) => parsed(w).at(-1);
/** --json without --yes: still never prompts. */
const JSON_ONLY = HOSTS.filter((a) => a !== "--yes");
const without = (flag: string) =>
  JSON_ONLY.filter((a, i) => a !== flag && JSON_ONLY[i - 1] !== flag);

describe("--json is non-interactive", () => {
  it("a missing required flag is action_required naming it, exit 2", async () => {
    for (const flag of ["--app-host", "--content-host", "--owner-email"]) {
      const w = world();
      expect(await run(without(flag), w.deps, ROOT)).toBe(2);
      expect(w.prompts).toEqual([]);
      expect(last(w)).toMatchObject({
        step: "args",
        status: "action_required",
      });
      expect(last(w).message).toContain(flag);
    }
  });

  it("--yes without --json still errors on a missing flag", async () => {
    const w = world();
    const human = HOSTS.filter(
      (a, i) =>
        a !== "--json" && HOSTS[i - 1] !== "--app-host" && a !== "--app-host",
    );
    expect(await run(human, w.deps, ROOT)).toBe(1);
    expect(w.lines[0]).toMatch(/^✗ args: missing --app-host/);
  });

  it("a --name conflict is action_required, no confirmation prompt", async () => {
    const w = world({ state: { name: "open-artifacts" } });
    expect(await run([...JSON_ONLY, "--name", "other"], w.deps, ROOT)).toBe(2);
    expect(w.prompts).toEqual([]);
    expect(last(w)).toMatchObject({ step: "args", status: "action_required" });
    expect(last(w).message).toContain("--name");
    expect(JSON.parse(w.files.get(STATE) ?? "{}").name).toBe("open-artifacts");
  });

  it("several accounts are action_required naming --account-id", async () => {
    const w = world({ accounts: ["acc1", "acc2"] });
    expect(await run(JSON_ONLY, w.deps, ROOT)).toBe(2);
    expect(w.prompts).toEqual([]);
    expect(last(w)).toMatchObject({
      step: "prereqs",
      status: "action_required",
    });
    expect(last(w).message).toContain("--account-id");
    expect(w.creates).toEqual([]);
  });

  it("an Access 403 points to the token save line without prompting", async () => {
    const w = world({ org: "forbidden" });
    expect(await run(JSON_ONLY, w.deps, ROOT)).toBe(2);
    expect(w.prompts).toEqual([]);
    expect(last(w)).toMatchObject({
      step: "access",
      status: "action_required",
    });
    expect(last(w).message).toContain("saveCommand");
  });

  it("the optional ANALYTICS_TOKEN prompt is skipped", async () => {
    const w = world();
    expect(await run(JSON_ONLY, w.deps, ROOT)).toBe(0);
    expect(w.prompts).toEqual([]);
    expect(w.ops).not.toContain("put ANALYTICS_TOKEN");
  });
});

describe("welcome link", () => {
  it("selftest and agent-config emit welcomeUrl when published this run; never persisted", async () => {
    const w = world();
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    const url = "https://app.example.com/a/art1";
    const by = (s: string) => parsed(w).find((j) => j.step === s);
    expect(by("selftest").data.welcomeUrl).toBe(url);
    expect(by("agent-config").data.welcomeUrl).toBe(url);
    expect(w.files.get(STATE)).not.toContain("/a/art1");
    w.lines.length = 0;
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    // #6: a rerun tests MCP with the saved PAT file, so it reports the link again
    expect(by("selftest").data.welcomeUrl).toBe(url);
    expect(w.files.get(STATE)).not.toContain("/a/art1");
    const h = world();
    expect(
      await run(
        HOSTS.filter((a) => a !== "--json"),
        h.deps,
        ROOT,
      ),
    ).toBe(0);
    const cfg = h.lines.find((l) => l.startsWith("✓ agent-config")) ?? "";
    expect(cfg).toContain(url);
  });
});

describe("access rerun without OA_ACCESS_TOKEN", () => {
  const accessCalls = (w: W) => w.auths.filter((a) => a.includes("/access/"));
  const step = (w: W, s: string) => parsed(w).find((j) => j.step === s);
  async function installed() {
    const w = world();
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    w.lines.length = 0;
    w.auths.length = 0;
    return w;
  }

  it("is skipped from state with a note and no Access calls", async () => {
    const w = await installed();
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(accessCalls(w)).toEqual([]);
    expect(step(w, "access")).toMatchObject({
      status: "skipped",
      message:
        "Access not re-verified: to re-check, run `pnpm --reporter=silent oa:setup --token-links --json` to get the save line (`saveCommand`); the user runs it in their own terminal (in Claude Code, type `! ` then the line), and setup then reads ~/.open-artifacts/open-artifacts-access-token (or the OA_ACCESS_TOKEN env var)",
    });
  });

  it("with OA_ACCESS_TOKEN runs the full check", async () => {
    const w = await installed();
    w.deps.env.OA_ACCESS_TOKEN = "oa";
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(accessCalls(w).length).toBeGreaterThan(0);
    expect(accessCalls(w).every((a) => a.endsWith("Bearer oa"))).toBe(true);
    expect(step(w, "access").status).toBe("skipped");
    expect(step(w, "access").message).not.toContain("not re-verified");
  });

  it("--new-owner-token without the token skips access", async () => {
    const w = await installed();
    const argv = [...HOSTS, "--new-owner-token"];
    expect(await run(argv, w.deps, ROOT)).toBe(0);
    expect(accessCalls(w)).toEqual([]);
    expect(step(w, "access").status).toBe("skipped");
    expect(step(w, "owner-token").status).toBe("ok");
  });

  it("a missing Worker secret still runs the full check", async () => {
    const w = world({ org: "forbidden" });
    w.deps.env.OA_ACCESS_TOKEN = "oa";
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    delete w.deps.env.OA_ACCESS_TOKEN;
    w.lines.length = 0;
    w.auths.length = 0;
    // Same state, but the Worker lost ACCESS_CLIENT_SECRET: no shortcut.
    const st = w.state();
    const fresh = world({ org: "forbidden", state: st, secrets: [] });
    expect(await run(HOSTS, fresh.deps, ROOT)).toBe(2);
    expect(step(fresh, "access").status).toBe("action_required");
  });
});

describe("B16-4 review fixes", () => {
  const step = (w: W, s: string) => parsed(w).find((j) => j.step === s);

  it("a changed --app-host takes the full Access path, not the skip", async () => {
    const w = world();
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    const copied = world({
      org: "forbidden",
      state: w.state(),
      secrets: [
        "ACCESS_CLIENT_SECRET",
        "SESSION_SECRET",
        "CONTENT_SIGNING_KEY",
      ],
    });
    const argv = HOSTS.map((a) =>
      a === "app.example.com" ? "app2.example.com" : a,
    );
    expect(await run(argv, copied.deps, ROOT)).toBe(2);
    expect(step(copied, "access").status).toBe("action_required");
    expect(copied.auths.some((a) => a.includes("/access/"))).toBe(true);
  });

  it("a changed account takes the full Access path, not the skip", async () => {
    const w = world();
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    const copied = world({
      org: "forbidden",
      accounts: ["acc1", "acc2"],
      state: { ...w.state(), accountId: "acc1" },
      secrets: [
        "ACCESS_CLIENT_SECRET",
        "SESSION_SECRET",
        "CONTENT_SIGNING_KEY",
      ],
    });
    const argv = [...HOSTS, "--account-id", "acc2"];
    expect(await run(argv, copied.deps, ROOT)).toBe(2);
    expect(step(copied, "access").status).toBe("action_required");
  });

  it("welcomeUrl must be an app-host /a/ URL; search and hash are stripped", async () => {
    for (const bad of [
      "https://a.b.usercontent.example.com/s/sig/art1/1/__view",
      "https://app.example.com/c/art1",
      "http://app.example.com/a/art1",
    ]) {
      const w = world({ viewUrl: bad });
      expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
      expect(w.lines.join("\n")).not.toContain(bad);
      expect(step(w, "selftest").data.welcomeUrl).toBeUndefined();
      expect(step(w, "selftest").message).toContain("welcome URL ignored");
      expect(step(w, "agent-config").data.welcomeUrl).toBeUndefined();
    }
    const w = world({ viewUrl: "https://app.example.com/a/art1?t=x#h" });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(step(w, "selftest").data.welcomeUrl).toBe(
      "https://app.example.com/a/art1",
    );
    expect(w.lines.join("\n")).not.toContain("t=x");
  });

  it("--json --yes together never prompts", async () => {
    const sites = [
      { w: world({ accounts: ["acc1", "acc2"] }), argv: HOSTS },
      { w: world({ org: "forbidden" }), argv: HOSTS },
      {
        w: world({ state: { name: "open-artifacts" } }),
        argv: [...HOSTS, "--name", "other"],
      },
      {
        w: world(),
        argv: HOSTS.filter(
          (a, i) => a !== "--app-host" && HOSTS[i - 1] !== "--app-host",
        ),
      },
    ];
    for (const { w, argv } of sites) {
      expect(argv).toEqual(expect.arrayContaining(["--json", "--yes"]));
      expect(await run(argv, w.deps, ROOT)).toBe(2);
      expect(w.prompts).toEqual([]);
      expect(last(w).status).toBe("action_required");
    }
    const ok = world();
    expect(await run(HOSTS, ok.deps, ROOT)).toBe(0);
    expect(ok.prompts).toEqual([]);
  });

  it("the non-interactive 403 message says to save the token and rerun", async () => {
    const w = world({ org: "forbidden" });
    expect(await run(JSON_ONLY, w.deps, ROOT)).toBe(2);
    expect(last(w).message).toContain(
      "save it with the line from `pnpm --reporter=silent oa:setup --token-links --json` (saveCommand), then rerun.",
    );
  });
});
