// #3328 S1: `oa-bus status` default screen (verdict, instances, agents by state,
// other projects, More footer) at 80 and 120 columns, with color and without.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveInstance } from "@oa/bus-daemon";
import { stripTerminalControls } from "@oa/bus-ipc";
import { describe, expect, it, vi } from "vitest";
import { status as statusCmd } from "../src/commands/status.ts";
import { cols } from "../src/copy.ts";
import { detectStyle, type Style } from "../src/term.ts";
import { fakeCtx, HUB, NS, status, TOKEN } from "./fake.ts";

const NONE: Style = { color: "none", dark: true, utf8: true };
const stripAnsi = stripTerminalControls;

function setup(opts: {
  st?: Parameters<typeof status>[0];
  style?: Style;
  columns?: number;
  label?: string;
  secondHub?: string;
  version?: string;
  fetch?: typeof fetch;
}) {
  const style = opts.style ?? NONE;
  const ctx = fakeCtx({
    style,
    version: opts.version ?? "0.262.0",
    busCmd: "oa-bus",
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    status: vi.fn(async () => status(opts.st)),
  });
  if (opts.columns !== undefined) ctx.stdout.columns = opts.columns;
  mkdirSync(ctx.home, { recursive: true });
  writeFileSync(
    join(ctx.home, "machine.json"),
    JSON.stringify({
      hub: HUB,
      machine_id: "m",
      label: opts.label ?? "leonardos-macbook-pro",
      machine_token: TOKEN,
    }),
    { mode: 0o600 },
  );
  if (opts.secondHub) {
    saveInstance(
      {
        name: "mit-ai",
        hub: opts.secondHub,
        machine_id: "",
        label: opts.label ?? "leonardos-macbook-pro",
        machine_token: `oa_machine_${"b".repeat(28)}7f3a`,
      },
      ctx.home,
    );
  }
  return ctx;
}

const isoAgo = (now: number, ms: number) => new Date(now - ms).toISOString();

describe("oa-bus status default screen (#3328 S1)", () => {
  it("All OK at 120 columns: verdict, instances on one line, grouped agents, other projects, More", async () => {
    const now = 1_700_000_000_000;
    const ctx = setup({
      columns: 120,
      secondHub: "https://mit-ai.open-artifacts.app",
      st: {
        instances: [
          { name: "main", link: "connected", revoked: false, agents: 10 },
          { name: "mit-ai", link: "connected", revoked: false, agents: 1 },
        ],
        namespaces: [
          {
            namespace: NS,
            source: "git",
            agents: [
              {
                name: "OA Bus L-2",
                kind: "codex",
                machine: "leonardos-macbook-pro",
                state: "live",
                status: "waiting_on_owner",
                status_label: "#3265 idle decision; #3172 with prover",
                status_at: isoAgo(now, 3 * 3_600_000),
              },
              {
                name: "OA Auth L-2",
                kind: "codex",
                machine: "leonardos-macbook-pro",
                state: "live",
                status: "working",
                status_label: "resumed #3087 with OA Auth Prover-3",
                status_at: isoAgo(now, 6 * 60_000),
              },
              {
                name: "agy-5",
                kind: "antigravity",
                machine: "leonardos-macbook-pro",
                state: "live",
                status: "working",
                status_label: "watching CI for PR 3299 & PR 3304",
                status_at: isoAgo(now, 12 * 60_000),
              },
              {
                name: "OA Design",
                kind: "claude-code",
                machine: "leonardos-macbook-pro",
                state: "live",
                status: "working",
                status_label: "oa-bus status terminal mock",
                status_at: isoAgo(now, 60_000),
              },
              {
                name: "Prove release-chain fixes",
                kind: "codex",
                machine: "Leo-Workstation",
                state: "live",
                status: "working",
                status_label: "Watching next public release",
                status_at: isoAgo(now, 3 * 3_600_000),
              },
              {
                name: "OA Bus Pi",
                kind: "pi",
                machine: "Leo-Workstation",
                state: "live",
                status: "idle",
                status_label: "handed off",
                status_at: isoAgo(now, 4 * 24 * 3_600_000),
              },
              {
                name: "Fix Pi Config",
                kind: "claude-code",
                machine: "Leo-Workstation",
                state: "live",
              },
              // Unnamed hidden: default names with starting or no status
              {
                name: "agy",
                kind: "antigravity",
                machine: "leonardos-macbook-pro",
                state: "live",
                status: "idle",
                status_label: "starting",
                status_at: isoAgo(now, 60_000),
              },
              {
                name: "pi-2",
                kind: "pi",
                machine: "Leo-Workstation",
                state: "live",
              },
            ],
          },
          {
            namespace: "github.com/org/mit-ai",
            agents: [
              {
                name: "mit-worker",
                kind: "codex",
                machine: "leonardos-macbook-pro",
                state: "live",
                status: "working",
              },
            ],
          },
        ],
        late: [
          {
            from: "OA Auth L-2",
            to: "OA Bus L-2",
            excerpt: "secret late message",
            at: now - 60_000,
          },
        ],
      },
    });
    ctx.clock.t = now;

    expect(await statusCmd(ctx)).toBe(0);
    const lines = ctx.out();
    const joined = lines.join("\n");

    expect(lines[0]).toBe("oa-bus 0.262.0 · ● working · this MacBook");
    expect(lines[1]).toBe("  ✓ bus.example.com    ✓ mit-ai.open-artifacts.app");
    expect(joined).toContain(
      "Agents  7 named · 2 unnamed hidden · this project",
    );
    expect(joined).toContain("NEEDS YOU");
    expect(joined).toContain("WORKING");
    expect(joined).toContain("MacBook");
    expect(joined).toContain("Workstation");
    expect(joined).toContain("Prove release-chain fixes");
    expect(joined).not.toContain("Leo-Works");
    expect(joined).toContain("agy-5");
    expect(joined).toContain("agy");
    expect(joined).toContain("IDLE OVER A DAY (2)  Fix Pi Config, OA Bus Pi");
    expect(joined).toContain("Other projects: mit-ai (1)");
    expect(joined).toContain(
      "More: --agents · --messages · --instances · --json   or https://bus.example.com/settings/agents",
    );

    // Forbidden old wording
    expect(joined).not.toContain("● live");
    expect(joined).not.toContain("namespace from");
    expect(joined).not.toContain("pid ");
    expect(joined).not.toContain("Daemon running");
    expect(joined).not.toContain("Habits:");
    expect(joined).not.toContain("delivered late");
    expect(joined).not.toContain("secret late message");

    for (const l of lines) expect(cols(l)).toBeLessThanOrEqual(120);
  });

  it("All OK at 80 columns: drops machine column, stacks instances, wraps More, cuts status", async () => {
    const now = 1_700_000_000_000;
    const ctx = setup({
      columns: 80,
      secondHub: "https://mit-ai.open-artifacts.app",
      st: {
        instances: [
          { name: "main", link: "connected", revoked: false, agents: 2 },
          { name: "mit-ai", link: "connected", revoked: false, agents: 0 },
        ],
        namespaces: [
          {
            namespace: NS,
            agents: [
              {
                name: "OA Auth Prover-3",
                kind: "codex",
                machine: "leonardos-macbook-pro",
                state: "live",
                status: "working",
                status_label:
                  "Reviewing #3215 and monitoring exact-head CI across all workflows",
                status_at: isoAgo(now, 23 * 60_000),
              },
              {
                name: "OA Bus Pi",
                kind: "pi",
                machine: "Leo-Workstation",
                state: "live",
                status: "idle",
                status_at: isoAgo(now, 3 * 24 * 3_600_000),
              },
              {
                name: "Build 3139 mention notices with a very long agent name",
                kind: "codex",
                machine: "Leo-Workstation",
                state: "live",
              },
            ],
          },
        ],
      },
    });
    ctx.clock.t = now;

    expect(await statusCmd(ctx)).toBe(0);
    const lines = ctx.out();

    expect(lines[0]).toBe("oa-bus 0.262.0 · ● working · this MacBook");
    expect(lines[1]).toBe("  ✓ bus.example.com");
    expect(lines[2]).toBe("  ✓ mit-ai.open-artifacts.app");
    const proverLine = lines.find((l) => l.includes("OA Auth Prover-3")) ?? "";
    expect(proverLine).not.toContain("MacBook");
    expect(proverLine).toContain('…"');
    expect(proverLine).toContain("23m");
    expect(lines.at(-2)).toBe(
      "More: --agents · --messages · --instances · --json",
    );
    expect(lines.at(-1)).toBe("      https://bus.example.com/settings/agents");
    for (const l of lines) expect(cols(l)).toBeLessThanOrEqual(80);
  });

  it("Many agents: NEEDS YOU lists all, WORKING caps at 10 with overflow hint", async () => {
    const now = 1_700_000_000_000;
    const agents = [
      ...Array.from({ length: 3 }, (_, i) => ({
        name: `Needs-${i + 1}`,
        kind: "codex" as const,
        machine: "leonardos-macbook-pro",
        state: "live" as const,
        status: "blocked" as const,
        status_label: `blocked task ${i + 1}`,
        status_at: isoAgo(now, (i + 1) * 60_000),
      })),
      ...Array.from({ length: 14 }, (_, i) => ({
        name: `Worker-${String(i + 1).padStart(2, "0")}`,
        kind: "claude-code" as const,
        machine: "leonardos-macbook-pro",
        state: "live" as const,
        status: "working" as const,
        status_label: `working on slice ${i + 1}`,
        status_at: isoAgo(now, (i + 1) * 60_000),
      })),
    ];
    const ctx = setup({
      columns: 120,
      st: { namespaces: [{ namespace: NS, agents }] },
    });
    ctx.clock.t = now;

    expect(await statusCmd(ctx)).toBe(0);
    const lines = ctx.out();
    const joined = lines.join("\n");
    expect(joined).toContain("Needs-1");
    expect(joined).toContain("Needs-2");
    expect(joined).toContain("Needs-3");
    expect(joined).toContain("Worker-01");
    expect(joined).toContain("Worker-10");
    expect(joined).not.toContain("Worker-11");
    expect(joined).toContain("… 4 more working  (oa-bus status --agents)");
    for (const l of lines) expect(cols(l)).toBeLessThanOrEqual(120);
  });

  it("Degraded when one of two instances can't reach; down when all fail", async () => {
    const deg = setup({
      columns: 120,
      secondHub: "https://mit-ai.open-artifacts.app",
      st: {
        instances: [
          { name: "main", link: "connected", revoked: false, agents: 1 },
          { name: "mit-ai", link: "not_connected", revoked: false, agents: 0 },
        ],
        namespaces: [{ namespace: NS, agents: [] }],
      },
    });
    expect(await statusCmd(deg)).toBe(1);
    expect(deg.out()[0]).toBe("oa-bus 0.262.0 · ▲ degraded · this MacBook");
    expect(deg.out()[1]).toBe(
      "  ✓ bus.example.com    ✗ mit-ai.open-artifacts.app (can't reach)",
    );

    const down = setup({
      columns: 80,
      st: { hub: "connecting", hub_error: "ECONNREFUSED" },
    });
    expect(await statusCmd(down)).toBe(1);
    expect(down.out()[0]).toBe("oa-bus 0.262.0 · ✗ down · this MacBook");
    expect(down.out()[1]).toBe("  ✗ bus.example.com (can't reach)");
  });

  it("Fits 80 and 120 columns with truecolor ANSI, NO_COLOR, piped stdout, CJK/emoji, and hostile escapes", async () => {
    const now = 1_700_000_000_000;
    const styles: [string, Style][] = [
      [
        "truecolor",
        detectStyle(
          { FORCE_COLOR: "3", LANG: "en_US.UTF-8" },
          { isTTY: true, hasColors: () => true },
        ),
      ],
      [
        "NO_COLOR",
        detectStyle(
          { NO_COLOR: "1", LANG: "en_US.UTF-8" },
          { isTTY: true, hasColors: () => true },
        ),
      ],
      ["pipe", detectStyle({ LANG: "en_US.UTF-8" }, { isTTY: false })],
    ];
    for (const width of [80, 120]) {
      for (const [label, style] of styles) {
        const ctx = setup({
          columns: width,
          style,
          st: {
            namespaces: [
              {
                namespace: NS,
                agents: [
                  {
                    name: `\x1b[31m書いている${"😀".repeat(15)}`,
                    kind: "codex",
                    machine: "leonardos-macbook-pro",
                    state: "live",
                    status: "working",
                    status_label: `\x1b]52;c;aGk=\x07テスト${"🚀".repeat(40)}`,
                    status_at: isoAgo(now, 5 * 60_000),
                  },
                ],
              },
            ],
          },
        });
        ctx.clock.t = now;
        expect(await statusCmd(ctx)).toBe(0);
        const lines = ctx.out();
        for (const l of lines) {
          if (label === "NO_COLOR" || label === "pipe") {
            expect(l).not.toContain("\x1b");
          }
          expect(l).not.toContain("\x07");
          expect(l).not.toContain("52;c");
          expect(cols(stripAnsi(l))).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  it("shows waiting permission in NEEDS YOU above waiting_on_owner (#3363)", async () => {
    const now = Date.UTC(2026, 10, 28, 12, 0, 0);
    const ctx = setup({
      columns: 120,
      st: {
        namespaces: [
          {
            namespace: NS,
            agents: [
              {
                name: "OwnerWaiter",
                kind: "codex",
                machine: "leonardos-macbook-pro",
                state: "live",
                status: "waiting_on_owner",
                status_label: "waiting on spec",
                status_at: isoAgo(now, 30_000),
              },
              {
                name: "Builder",
                kind: "claude-code",
                machine: "leonardos-macbook-pro",
                state: "live",
                status: "working",
                status_label: "running tests",
                status_at: isoAgo(now, 5 * 60_000),
                waiting: {
                  kind: "permission",
                  label: "run a command",
                  since: isoAgo(now, 2 * 60_000),
                },
              },
              {
                name: "Reviewer",
                kind: "antigravity",
                machine: "leonardos-macbook-pro",
                state: "live",
                waiting: {
                  kind: "permission",
                  since: isoAgo(now, 60_000),
                },
              },
            ],
          },
        ],
      },
    });
    ctx.clock.t = now;
    expect(await statusCmd(ctx)).toBe(0);
    const text = ctx.out().map(stripAnsi).join("\n");
    expect(text).toContain("NEEDS YOU");
    expect(text).toContain("Waiting for your OK (run a command)");
    expect(text).toContain("Waiting for your OK");
    // Permission waits rank above waiting_on_owner even when waiting_on_owner is newer.
    expect(text.indexOf("Builder")).toBeLessThan(text.indexOf("OwnerWaiter"));
    expect(text.indexOf("Reviewer")).toBeLessThan(text.indexOf("OwnerWaiter"));
  });
});
