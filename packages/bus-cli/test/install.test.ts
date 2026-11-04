import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { install, loginStep, rosterBlock } from "../src/commands/install.ts";
import { uninstall } from "../src/commands/uninstall.ts";
import type { Ctx } from "../src/context.ts";
import { copy } from "../src/copy.ts";
import { main } from "../src/main.ts";
import {
  deviceCode,
  type Fake,
  fakeCtx,
  HUB,
  LABEL,
  NS,
  status,
  TAGS,
  TOKEN,
  transcript,
  URL_,
} from "./fake.ts";

const AGENTS = [
  ["oa-bus-backend", "claude-code"],
  ["oa-bus-design", "claude-code"],
  ["builder-e0", "opencode"],
  ["oa-bus-frontend", "pi", "leo-linux-box"],
  ["oa-bus-platform", "claude-code", "leo-mac-mini", "queued"],
].map(([name, kind, machine, state]) => ({
  name: name as string,
  kind: kind as "claude-code" | "opencode" | "pi",
  machine: machine ?? LABEL,
  state: (state ?? "live") as "live" | "queued",
}));
const withAgents = (agents = AGENTS) =>
  status({ namespaces: [{ namespace: NS, agents }] });

/** A hub that answers /device/code, then each poll in turn. */
function hub(polls: unknown[], code: () => Response = deviceCode) {
  return vi.fn(async (url: string | URL | Request) => {
    if (String(url).endsWith("/device/code")) return code();
    const next = polls.shift();
    if (next instanceof Error) throw next;
    return Response.json(next);
  }) as unknown as typeof fetch;
}
const approved = {
  status: "approved",
  machine_id: "mmmmmmmmmmmmmmm1",
  token: TOKEN,
};

const allHarnesses = (over: Partial<Ctx> = {}) => ({
  which: (c: string) => ["claude", "opencode", "pi"].includes(c),
  exec: vi.fn(async (cmd: string, args: string[]) =>
    cmd === "opencode" && args[0] === "--version"
      ? { code: 0, stdout: "opencode v2.0.32\n", stderr: "" }
      : { code: 0, stdout: "", stderr: "" },
  ),
  service: {
    kind: "launchd" as const,
    ensure: vi.fn(async () => ({})),
    remove: vi.fn(async () => ({ unit: "launchd" as const })),
    cli: () => ["oa-bus"],
  },
  status: vi.fn(async () => withAgents()),
  ...over,
});

const run = (ctx: Fake, opts: Parameters<typeof install>[0] = {}) =>
  install({ label: LABEL, hub: HUB, ...opts }, ctx);

describe("install: transcript state 1, first run", () => {
  it("prints every line of the transcript, non-TTY", async () => {
    const ctx = fakeCtx({
      fetch: hub([{ status: "pending" }, approved]),
      ...allHarnesses(),
    });
    expect(await run(ctx)).toBe(0);
    const [first, after] = transcript("## 1. First run, browser opens");
    const waiting = (first as string[]).length - 1;
    expect(ctx.out()).toEqual([
      ...(first as string[]).slice(0, waiting),
      "Waiting for approval (up to 10 minutes)…",
      ...(after as string[]),
    ]);
    expect(ctx.err()).toEqual([]);
    // The browser got the URL; the token never reached stdout.
    expect(ctx.openBrowser).toHaveBeenCalledWith(URL_);
    expect(ctx.out().join("\n")).not.toContain(TOKEN);
  });

  it("on a TTY draws the spinner with time left, then erases it", async () => {
    const ctx = fakeCtx(
      { fetch: hub([{ status: "pending" }, approved]), ...allHarnesses() },
      true,
    );
    expect(await run(ctx)).toBe(0);
    const [first] = transcript("## 1. First run, browser opens");
    const raw = ctx.raw();
    expect(raw).toContain(
      "[[warning]]⠋[[/warning]]  Waiting for approval  [[muted]]10:00 left[[/muted]]\n\x1b[1F\x1b[0J",
    );
    expect(raw).not.toContain("Waiting for approval (up to");
    // The transcript's own example frame renders exactly.
    expect(copy(TAGS).waiting("⠋", (9 * 60 + 41) * 1000, false)).toBe(
      (first as string[]).at(-1),
    );
  });

  it("marks a failing poll on the spinner line until one succeeds", () => {
    expect(copy(TAGS).waiting("⠋", 581_000, true)).toBe(
      "[[warning]]⠋[[/warning]]  Waiting for approval  [[muted]]9:41 left[[/muted]]  [[warning]]hub unreachable, retrying[[/warning]]",
    );
  });

  it("lists only the harnesses found, and no OpenCode line without OpenCode", async () => {
    const ctx = fakeCtx({
      fetch: hub([approved]),
      ...allHarnesses({ which: (c) => c === "claude" || c === "pi" }),
    });
    await run(ctx);
    expect(ctx.out()).toContain(
      "[[success]]✓[[/success]]  Configured Claude Code and Pi",
    );
    expect(ctx.out().join("\n")).not.toContain("OpenCode service");
  });

  it("says when Pi and oh-my-pi share one extension file (C23b)", async () => {
    const ctx = fakeCtx({
      fetch: hub([approved]),
      ...allHarnesses({ which: (c) => c === "pi" || c === "omp" }),
    });
    ctx.env = { PI_CODING_AGENT_DIR: `${ctx.userHome}/agent` };
    await run(ctx);
    const out = ctx.out();
    const i = out.indexOf(
      "[[success]]✓[[/success]]  Configured Pi and oh-my-pi",
    );
    expect(i).toBeGreaterThan(-1);
    expect(out[i + 1]).toBe(
      "   [[muted]]Pi and oh-my-pi share one extension folder, so one file serves both.[[/muted]]",
    );
  });

  it("lists all four harnesses when all are found", async () => {
    const ctx = fakeCtx({
      fetch: hub([approved]),
      ...allHarnesses({
        which: (c) => ["claude", "opencode", "pi", "omp"].includes(c),
      }),
    });
    await run(ctx);
    expect(ctx.out()).toContain(
      "[[success]]✓[[/success]]  Configured Claude Code, OpenCode, Pi and oh-my-pi",
    );
    expect(ctx.out().join("\n")).not.toContain("share one extension");
  });

  it("says when the OpenCode service is not running", async () => {
    const ctx = fakeCtx({
      fetch: hub([approved]),
      ...allHarnesses({
        exec: vi.fn(async (_cmd: string, args: string[]) =>
          args[0] === "--version"
            ? { code: 0, stdout: "opencode v2.0.32", stderr: "" }
            : args[0] === "service"
              ? { code: 1, stdout: "", stderr: "service not running" }
              : { code: 0, stdout: "", stderr: "" },
        ),
      }),
    });
    await run(ctx);
    expect(ctx.out()).toContain(
      "[[success]]✓[[/success]]  OpenCode service not running; it loads the plugin when it starts",
    );
  });

  it("warns, and still succeeds, when no harness is found", async () => {
    const ctx = fakeCtx({
      fetch: hub([approved]),
      ...allHarnesses({ which: () => false }),
    });
    expect(await run(ctx)).toBe(0);
    expect(ctx.out()).toEqual(
      expect.arrayContaining([
        "[[warning]]![[/warning]]  No Claude Code, OpenCode, Pi, oh-my-pi or Codex found",
        "   Install one, then run npx @open-artifacts/bus again.",
      ]),
    );
  });

  it("prints the upgrade line for an OpenCode below 2.0.0", async () => {
    const ctx = fakeCtx({
      fetch: hub([approved]),
      ...allHarnesses({
        which: (c) => c === "opencode",
        exec: vi.fn(async () => ({
          code: 0,
          stdout: "opencode v1.4.2",
          stderr: "",
        })),
      }),
    });
    expect(await run(ctx)).toBe(0);
    // The same two lines as doctor's (transcript state 8).
    const doctor = transcript("## 8. doctor")[1] as string[];
    const i = doctor.findIndex((l) => l.includes("OpenCode 1.4.2"));
    expect(ctx.out()).toEqual(expect.arrayContaining(doctor.slice(i, i + 2)));
  });

  it("no agents yet: the namespace line and the join hint, no table", async () => {
    const ctx = fakeCtx({
      fetch: hub([approved]),
      ...allHarnesses({ status: vi.fn(async () => withAgents([])) }),
    });
    await run(ctx);
    expect(ctx.out().slice(-4)).toEqual([
      `No agents in namespace [[accent]]${NS}[[/accent]] yet.`,
      "Start Claude Code, OpenCode, Pi, oh-my-pi or Codex in this folder and it joins.",
      "",
      "[[muted]]Check this machine anytime with npx @open-artifacts/bus status.[[/muted]]",
    ]);
  });

  it("names a systemd user service on Linux", async () => {
    const ctx = fakeCtx({
      fetch: hub([approved]),
      ...allHarnesses({
        service: {
          kind: "systemd",
          ensure: async () => ({}),
          remove: async () => ({ unit: "systemd" as const }),
          cli: () => ["oa-bus"],
        },
      }),
    });
    await run(ctx);
    expect(ctx.out()).toContain(
      "[[success]]✓[[/success]]  Daemon running as a systemd user service  [[muted]]pid 48213[[/muted]]",
    );
  });
});

describe("install: Codex (C26e)", () => {
  const FIXTURE = readFileSync(
    new URL("./fixtures/codex-config.toml", import.meta.url),
    "utf8",
  );
  /** A ctx with a temp CODEX_HOME holding the fixture config, and no other harness. */
  const codexCtx = (path = "") => {
    const ctx = fakeCtx({
      fetch: hub([approved]),
      ...allHarnesses({ which: () => false }),
    });
    const codexHome = join(ctx.userHome, "codex");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "config.toml"), FIXTURE);
    ctx.env = { CODEX_HOME: codexHome, PATH: path };
    return { ctx, config: join(codexHome, "config.toml") };
  };

  it("configures Codex in its config.toml and says wake is unavailable without a binary", async () => {
    const { ctx, config } = codexCtx();
    expect(await run(ctx)).toBe(0);
    expect(ctx.out()).toEqual(
      expect.arrayContaining([
        "[[success]]✓[[/success]]  Configured Codex",
        "[[warning]]![[/warning]]  No codex binary found, so Open Artifacts bus can't wake an idle Codex thread.",
        "   Install the Codex CLI, then run npx @open-artifacts/bus again.",
      ]),
    );
    const text = readFileSync(config, "utf8");
    expect(text.startsWith(FIXTURE)).toBe(true);
    expect(text).toContain(
      '[mcp_servers.oa_bus]\ncommand = "oa-bus"\nargs = ["mcp", "codex"]\ndefault_tools_approval_mode = "approve"\n',
    );
  });

  it("install --check writes nothing, then passes after an install; uninstall restores the config", async () => {
    const { ctx, config } = codexCtx();
    expect(await run(ctx, { check: true })).toBe(1);
    expect(ctx.all()).toContain(
      "[[danger]]×[[/danger]]  Harnesses not configured",
    );
    expect(readFileSync(config, "utf8")).toBe(FIXTURE);
    expect(existsSync(`${config}.oa-bus.bak`)).toBe(false);
    expect(await run(ctx)).toBe(0);
    expect(await uninstall({ purge: false }, ctx)).toBe(0);
    expect(ctx.out()).toContain(
      "[[success]]✓[[/success]]  Removed Open Artifacts bus from Codex",
    );
    expect(readFileSync(config, "utf8")).toBe(FIXTURE);
  });

  it("skips a config that is not TOML with the transcript's lines", async () => {
    const { ctx, config } = codexCtx();
    writeFileSync(config, "[[[\n");
    expect(await run(ctx)).toBe(0);
    expect(ctx.out()).toEqual(
      expect.arrayContaining([
        "[[warning]]![[/warning]]  Skipped Codex: ~/codex/config.toml is not valid TOML",
        "   Fix it, then run npx @open-artifacts/bus again.",
      ]),
    );
    expect(readFileSync(config, "utf8")).toBe("[[[\n");
  });

  it("pins the wake binary it finds on PATH", async () => {
    const dir = join(tmpdir(), `ob-codex-bin-${process.pid}-${Date.now()}`);
    mkdirSync(dir);
    writeFileSync(join(dir, "codex"), "#!/bin/sh\n", { mode: 0o755 });
    const { ctx } = codexCtx(dir);
    expect(await run(ctx)).toBe(0);
    expect(ctx.out().join("\n")).not.toContain("No codex binary");
    expect(
      JSON.parse(readFileSync(join(ctx.home, "codex.json"), "utf8")),
    ).toEqual({ bin: join(dir, "codex") });
  });
});

describe("install: daemon confirmation", () => {
  it("prints Daemon running only after the socket answers", async () => {
    let calls = 0;
    const ctx = fakeCtx({
      fetch: hub([approved]),
      ...allHarnesses({
        status: vi.fn(async () => {
          if (++calls < 3) throw new Error("ECONNREFUSED");
          return status();
        }),
      }),
    });
    expect(await run(ctx)).toBe(0);
    expect(calls).toBe(3);
    expect(ctx.service.ensure).toHaveBeenCalledOnce();
  });

  it("gives up after 10 seconds: the transcript's failure, on stderr, nothing after", async () => {
    const ctx = fakeCtx({
      fetch: hub([approved]),
      ...allHarnesses({
        status: vi.fn(async () => {
          throw new Error("ECONNREFUSED");
        }),
      }),
    });
    const start = ctx.clock.t;
    expect(await run(ctx)).toBe(1);
    // One 5 s approval poll, then the 10 s wait.
    expect(ctx.clock.t - start).toBeGreaterThanOrEqual(15_000);
    expect(ctx.clock.t - start).toBeLessThan(16_000);
    expect(ctx.err()).toEqual([
      "[[danger]]×[[/danger]]  The daemon did not start within 10 seconds.",
      "   Run npx @open-artifacts/bus doctor to see why.",
    ]);
    expect(ctx.out().at(-1)).toMatch(/OpenCode service/);
  });
});

describe("install --no-service (C25)", () => {
  it("makes no service call, starts nothing, and says how to run the daemon", async () => {
    const ctx = fakeCtx({
      fetch: hub([approved]),
      ...allHarnesses({
        status: vi.fn(async () => {
          throw new Error("ECONNREFUSED");
        }),
      }),
    });
    expect(await run(ctx, { noService: true })).toBe(0);
    expect(ctx.service.ensure).not.toHaveBeenCalled();
    expect(ctx.service.remove).not.toHaveBeenCalled();
    expect(ctx.out().join("\n")).toContain("Configured");
    expect(ctx.out().join("\n")).toContain("npx @open-artifacts/bus daemon");
    expect(ctx.err()).toEqual([]);
  });

  it("reports a daemon the user already runs", async () => {
    const ctx = fakeCtx({ fetch: hub([approved]), ...allHarnesses() });
    expect(await run(ctx, { noService: true })).toBe(0);
    expect(ctx.service.ensure).not.toHaveBeenCalled();
    const out = ctx.out().join("\n");
    expect(out).toContain(
      "Daemon running without a service, so it won't restart after a reboot.",
    );
    expect(out).toContain(
      "After a reboot, start it again with npx @open-artifacts/bus daemon.",
    );
    expect(out).not.toContain("Run npx @open-artifacts/bus install");
  });
});

describe("install: transcript states 2 to 6", () => {
  it("2: no browser", async () => {
    const ctx = fakeCtx({
      fetch: hub([approved]),
      openBrowser: vi.fn(async () => false),
      ...allHarnesses(),
    });
    await run(ctx);
    const [block] = transcript("## 2. No browser");
    expect(ctx.out().slice(0, 10)).toEqual([
      ...(block as string[]).slice(0, -1),
      "Waiting for approval (up to 10 minutes)…",
    ]);
  });

  it("2: --no-open never opens the browser and says so", async () => {
    const ctx = fakeCtx({ fetch: hub([approved]), ...allHarnesses() });
    await run(ctx, { noOpen: true });
    expect(ctx.openBrowser).not.toHaveBeenCalled();
    expect(ctx.out()[2]).toBe("→  Open this URL on any machine:");
    expect(ctx.out()[3]).toBe(`   [[accent]]${URL_}[[/accent]]`);
  });

  it("3: denied", async () => {
    const ctx = fakeCtx({
      fetch: hub([{ status: "denied" }]),
      ...allHarnesses(),
    });
    expect(await run(ctx)).toBe(1);
    expect(ctx.err()).toEqual(transcript("## 3. Denied")[0]);
    expect(existsSync(join(ctx.home, "machine.json"))).toBe(false);
    expect(ctx.out().at(-1)).toBe("Waiting for approval (up to 10 minutes)…");
  });

  it("4: expired, from the hub or from the clock", async () => {
    const want = transcript("## 4. Expired")[0];
    const a = fakeCtx({
      fetch: hub([{ status: "expired" }]),
      ...allHarnesses(),
    });
    expect(await run(a)).toBe(1);
    expect(a.err()).toEqual(want);
    const b = fakeCtx({
      fetch: hub(Array(500).fill({ status: "pending" })),
      ...allHarnesses(),
    });
    expect(await run(b)).toBe(1);
    expect(b.err()).toEqual(want);
  });

  it("5: already registered", async () => {
    const ctx = fakeCtx(allHarnesses());
    mkdirSync(ctx.home, { recursive: true });
    writeFileSync(
      join(ctx.home, "machine.json"),
      JSON.stringify({
        hub: HUB,
        machine_id: "m",
        label: LABEL,
        machine_token: TOKEN,
      }),
      { mode: 0o600 },
    );
    expect(await run(ctx)).toBe(0);
    const [block] = transcript("## 5. Already registered");
    expect(ctx.out().slice(0, 8)).toEqual((block as string[]).slice(0, 8));
    expect(ctx.fetch).not.toHaveBeenCalled();
  });

  it("6: retries /device/code at 2, 4 and 8 s, then succeeds", async () => {
    let n = 0;
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/device/code")) {
        if (++n < 3)
          throw Object.assign(new TypeError("fetch failed"), {
            cause: { code: "ECONNREFUSED" },
          });
        return deviceCode();
      }
      return Response.json(approved);
    }) as unknown as typeof globalThis.fetch;
    const ctx = fakeCtx({ fetch, ...allHarnesses() });
    expect(await run(ctx)).toBe(0);
    expect(ctx.sleep).toHaveBeenNthCalledWith(1, 2000);
    expect(ctx.sleep).toHaveBeenNthCalledWith(2, 4000);
    const [block] = transcript("## 6. Hub unreachable");
    // Non-TTY: each attempt prints its own lines; the second is the transcript's.
    expect(ctx.out().slice(2, 6)).toEqual([
      "[[warning]]![[/warning]]  Couldn't reach bus.example.com",
      "   [[muted]]Retrying in 2 s… attempt 2 of 4[[/muted]]",
      ...(block as string[]).slice(2),
    ]);
    expect(ctx.out()[6]).toBe(
      "→  Opening your browser to approve this machine",
    );
  });

  it("6: on a TTY the retry lines are redrawn in place and erased on success", async () => {
    let n = 0;
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/device/code")) {
        if (++n < 2) return new Response("", { status: 502 });
        return deviceCode();
      }
      return Response.json(approved);
    }) as unknown as typeof globalThis.fetch;
    const ctx = fakeCtx({ fetch, ...allHarnesses() }, true);
    await run(ctx);
    expect(ctx.raw()).toContain(
      "attempt 2 of 4[[/muted]]\n\x1b[2F\x1b[0J→  Opening your browser",
    );
  });

  it("6: after the fourth failure, the final error with the last cause", async () => {
    const fetch = vi.fn(
      async () => new Response("", { status: 502 }),
    ) as unknown as typeof globalThis.fetch;
    const ctx = fakeCtx({ fetch, ...allHarnesses() });
    expect(await run(ctx)).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(ctx.err()).toEqual([
      "[[danger]]×[[/danger]]  Couldn't reach bus.example.com after 4 attempts.  [[muted]]HTTP 502[[/muted]]",
      "   Check your network or the --instance URL, then run npx @open-artifacts/bus again.",
    ]);
    const [, final] = transcript("## 6. Hub unreachable");
    expect((final as string[])[1]).toBe(ctx.err()[1]);
    expect((final as string[])[0]).toBe(
      ctx.err()[0]?.replace("HTTP 502", "ECONNREFUSED"),
    );
  });

  it("6: a timeout is named timeout", async () => {
    const fetch = vi.fn(async () => {
      throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    }) as unknown as typeof globalThis.fetch;
    const ctx = fakeCtx({ fetch, ...allHarnesses() });
    await run(ctx);
    expect(ctx.err()[0]).toMatch(/\[\[muted\]\]timeout\[\[\/muted\]\]$/);
  });
});

function approveFor(ctx: Fake, hubUrl = HUB) {
  mkdirSync(ctx.home, { recursive: true });
  writeFileSync(
    join(ctx.home, "machine.json"),
    JSON.stringify({
      hub: hubUrl,
      machine_id: "m",
      label: LABEL,
      machine_token: TOKEN,
    }),
    { mode: 0o600 },
  );
}

describe("install: an approved machine", () => {
  it("revoked: runs the device flow again and clears the marker", async () => {
    const ctx = fakeCtx({ fetch: hub([approved]), ...allHarnesses() });
    approveFor(ctx);
    writeFileSync(join(ctx.home, "revoked"), "{}\n");
    expect(await loginStep(ctx, { hub: HUB, label: LABEL })).toBe(true);
    expect(ctx.fetch).toHaveBeenCalled();
    expect(ctx.out().join("\n")).not.toMatch(/Already connected/);
    expect(existsSync(join(ctx.home, "revoked"))).toBe(false);
  });

  it("revoked, with no --instance: re-approves on machine.json's hub", async () => {
    const ctx = fakeCtx({ fetch: hub([approved]), ...allHarnesses() });
    approveFor(ctx);
    writeFileSync(join(ctx.home, "revoked"), "{}\n");
    expect(await loginStep(ctx, { label: LABEL })).toBe(true);
    expect(String(vi.mocked(ctx.fetch).mock.calls[0]?.[0])).toBe(
      `${HUB}/device/code`,
    );
  });

  it("`npx @open-artifacts/bus login` always runs the device flow", async () => {
    const ctx = fakeCtx({ fetch: hub([approved]), ...allHarnesses() });
    approveFor(ctx);
    expect(await main(["login", "--instance", HUB], () => ctx)).toBe(0);
    expect(ctx.fetch).toHaveBeenCalled();
    expect(ctx.out().join("\n")).not.toMatch(/Already connected/);
  });

  it("login says a running daemon still uses the old token", async () => {
    const ctx = fakeCtx({
      fetch: hub([approved]),
      ...allHarnesses(),
      status: vi.fn(async () => status({ pid: 48213 })),
    });
    approveFor(ctx);
    expect(await main(["login", "--instance", HUB], () => ctx)).toBe(0);
    expect(ctx.out().slice(-2)).toEqual(transcript("## login")[1]);
  });

  it("install --instance <other> refuses instead of keeping the old hub", async () => {
    const ctx = fakeCtx(allHarnesses());
    approveFor(ctx);
    expect(await run(ctx, { hub: "https://other.example.org" })).toBe(1);
    expect(ctx.fetch).not.toHaveBeenCalled();
    expect(ctx.all()).toEqual(transcript("## 5. Already registered")[1]);
  });

  it("install --instance with the same hub stays connected", async () => {
    const ctx = fakeCtx(allHarnesses());
    approveFor(ctx);
    expect(await run(ctx, { hub: `${HUB}/` })).toBe(0);
    expect(ctx.out()[2]).toMatch(/Already connected/);
  });
});

describe("install: why OpenCode was skipped", () => {
  const ctxWith = (exec: Ctx["exec"]) =>
    fakeCtx({
      fetch: hub([approved]),
      ...allHarnesses({ which: (c) => c === "opencode", exec }),
    });

  it("an unreadable version is 'version unknown', not 'too old'", async () => {
    const ctx = ctxWith(
      vi.fn(async () => ({ code: 0, stdout: "banner\n", stderr: "" })),
    );
    await run(ctx);
    expect(ctx.out()).toContain(
      "[[warning]]![[/warning]]  OpenCode version unknown",
    );
    expect(ctx.out().join("\n")).not.toMatch(/too old/);
  });

  it("any other reason is printed as it is", async () => {
    const ctx = ctxWith(
      vi.fn(async (_c: string, a: string[]) => ({
        code: 0,
        stdout: a[0] === "--version" ? "opencode v2.0.32" : "",
        stderr: "",
      })),
    );
    mkdirSync(join(ctx.userHome, ".config/opencode"), { recursive: true });
    writeFileSync(
      join(ctx.userHome, ".config/opencode/opencode.json"),
      "[1, 2]",
    );
    await run(ctx);
    const out = ctx.out().join("\n");
    expect(out).toMatch(/Skipped OpenCode: .*left it untouched/);
    expect(out).not.toMatch(/too old|version unknown/);
  });
});

describe("install: no service yet", () => {
  it("the daemon line is a warning, and the install still succeeds", async () => {
    const ctx = fakeCtx({
      fetch: hub([approved]),
      ...allHarnesses({
        service: {
          ensure: async () => ({}),
          remove: async () => ({}),
          cli: () => ["oa-bus"],
        },
      }),
    });
    expect(await run(ctx)).toBe(0);
    expect(ctx.out()).toEqual(
      expect.arrayContaining([
        "[[warning]]![[/warning]]  Daemon running, but no service will restart it after a reboot.",
        "   Run npx @open-artifacts/bus install.",
      ]),
    );
    expect(ctx.out().join("\n")).not.toMatch(/✓.*Daemon running/);
  });
});

describe("install: no hub", () => {
  it("without --instance or OA_BUS_INSTANCE it says how to pass one and exits 1", async () => {
    const ctx = fakeCtx(allHarnesses());
    expect(await install({ label: LABEL }, ctx)).toBe(1);
    expect(ctx.all()).toEqual(transcript("## 6. Hub unreachable")[2]);
    expect(ctx.fetch).not.toHaveBeenCalled();
  });

  it("OA_BUS_INSTANCE is enough", async () => {
    const ctx = fakeCtx({
      fetch: hub([approved]),
      env: { OA_BUS_INSTANCE: HUB },
      ...allHarnesses(),
    });
    expect(await install({ label: LABEL }, ctx)).toBe(0);
  });
});

describe("install: steps and install.json", () => {
  it("records each step and keeps the adapters' container records", async () => {
    const ctx = fakeCtx({ fetch: hub([approved]), ...allHarnesses() });
    mkdirSync(ctx.home, { recursive: true });
    writeFileSync(
      join(ctx.home, "install.json"),
      JSON.stringify({ created: { "/x": [["mcp"]] } }),
    );
    await run(ctx);
    const rec = JSON.parse(
      readFileSync(join(ctx.home, "install.json"), "utf8"),
    );
    expect(rec.created["/x"]).toEqual([["mcp"]]);
    expect(Object.keys(rec.steps)).toEqual(["login", "harnesses", "daemon"]);
    expect(rec.steps.daemon.status).toBe("ok");
  });

  it("stops at the first failed step and records it", async () => {
    const ctx = fakeCtx({
      fetch: hub([{ status: "denied" }]),
      ...allHarnesses(),
    });
    await run(ctx);
    const rec = JSON.parse(
      readFileSync(join(ctx.home, "install.json"), "utf8"),
    );
    expect(rec.steps).toEqual({
      login: expect.objectContaining({ status: "failed" }),
    });
    expect(ctx.service.ensure).not.toHaveBeenCalled();
  });

  it("--check prints each failing check with × and its next action; exit 1", async () => {
    const ctx = fakeCtx(
      allHarnesses({
        which: (c) => c === "pi",
        status: vi.fn(async () => {
          throw new Error("down");
        }),
      }),
    );
    approveFor(ctx);
    expect(await run(ctx, { check: true })).toBe(1);
    expect(ctx.all()).toEqual(transcript("## install --check")[0]);
    expect(ctx.exec).not.toHaveBeenCalled();
    expect(ctx.fetch).not.toHaveBeenCalled();
  });

  it("--check: a revoked machine is not approved", async () => {
    const ctx = fakeCtx(
      allHarnesses({ which: () => false, status: vi.fn(async () => status()) }),
    );
    approveFor(ctx);
    writeFileSync(join(ctx.home, "revoked"), "{}");
    expect(await run(ctx, { check: true })).toBe(1);
    expect(ctx.err()[0]).toBe("[[danger]]×[[/danger]]  Machine not approved");
  });

  it("--check: a machine not approved, and nothing written", async () => {
    const ctx = fakeCtx(allHarnesses({ which: () => false }));
    expect(await run(ctx, { check: true })).toBe(1);
    expect(ctx.err().slice(0, 2)).toEqual([
      "[[danger]]×[[/danger]]  Machine not approved",
      "   Run npx @open-artifacts/bus to approve it.",
    ]);
    expect(existsSync(ctx.home)).toBe(false);
    expect(ctx.exec).not.toHaveBeenCalled();
    expect(ctx.fetch).not.toHaveBeenCalled();
  });

  it("--check passes after an install", async () => {
    // `claude mcp add` fails here, so install writes ~/.claude.json itself.
    const exec = vi.fn(async (cmd: string, args: string[]) =>
      cmd === "claude"
        ? { code: 1, stdout: "", stderr: "no" }
        : args[0] === "--version"
          ? { code: 0, stdout: "opencode v2.0.32", stderr: "" }
          : { code: 0, stdout: "", stderr: "" },
    );
    const ctx = fakeCtx({ fetch: hub([approved]), ...allHarnesses({ exec }) });
    await run(ctx);
    const again = fakeCtx({
      ...allHarnesses(),
      userHome: ctx.userHome,
      home: ctx.home,
    });
    expect(await run(again, { check: true })).toBe(0);
    expect(again.out().slice(2)).toEqual([
      "[[success]]✓[[/success]]  Machine approved",
      "[[success]]✓[[/success]]  Harnesses configured",
      "[[success]]✓[[/success]]  Daemon answering",
    ]);
  });
});

describe("roster machine column", () => {
  it("fills a remote agent's machine from the daemon status", () => {
    const ctx = fakeCtx({});
    const { lines } = rosterBlock(ctx, {
      namespace: "ns",
      agents: [
        { name: "far", kind: "pi", machine: "desktop", state: "live" },
        { name: "old", kind: "pi", machine: "", state: "live" },
      ],
    });
    expect(lines[1]).toContain("desktop");
    expect(lines[2]).not.toContain("desktop");
  });
});
