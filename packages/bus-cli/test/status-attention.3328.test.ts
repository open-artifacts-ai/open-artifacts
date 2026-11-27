// #3328 S2: Needs attention block (printed only when something is wrong, with one
// plain fix per problem; late messages count only when well past normal delivery).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveInstance } from "@oa/bus-daemon";
import { stripTerminalControls } from "@oa/bus-ipc";
import { hostSlug } from "@oa/shared/secrets";
import { describe, expect, it, vi } from "vitest";
import {
  LATE_ATTENTION_MS,
  status as statusCmd,
} from "../src/commands/status.ts";
import { cols } from "../src/copy.ts";
import { SKILL_MARKER } from "../src/steps/skill.ts";
import type { Style } from "../src/term.ts";
import { fakeCtx, HUB, NS, status, TOKEN } from "./fake.ts";

const NONE: Style = { color: "none", dark: true, utf8: true };

function setup(opts: {
  st?: Parameters<typeof status>[0];
  down?: boolean;
  columns?: number;
  secondHub?: string;
  serviceKind?: "launchd" | "systemd";
}) {
  const ctx = fakeCtx({
    style: NONE,
    version: "0.262.0",
    busCmd: "oa-bus",
    ...(opts.serviceKind
      ? {
          service: {
            kind: opts.serviceKind,
            ensure: async () => ({}),
            remove: async () => ({}),
            cli: () => ["oa-bus"],
          },
        }
      : {}),
    status: opts.down
      ? vi.fn(async () => {
          throw Object.assign(new Error("connect ECONNREFUSED"), {
            code: "ECONNREFUSED",
          });
        })
      : vi.fn(async () => status(opts.st)),
  });
  if (opts.columns !== undefined) ctx.stdout.columns = opts.columns;
  mkdirSync(ctx.home, { recursive: true });
  writeFileSync(
    join(ctx.home, "machine.json"),
    JSON.stringify({
      hub: HUB,
      machine_id: "m",
      label: "leonardos-macbook-pro",
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
        label: "leonardos-macbook-pro",
        machine_token: `oa_machine_${"b".repeat(28)}7f3a`,
      },
      ctx.home,
    );
  }
  return ctx;
}

describe("oa-bus status Needs attention (#3328 S2)", () => {
  it("omits Needs attention completely when everything is OK", async () => {
    const ctx = setup({
      columns: 120,
      st: { namespaces: [{ namespace: NS, agents: [] }] },
    });
    expect(await statusCmd(ctx)).toBe(0);
    expect(ctx.out().join("\n")).not.toContain("Needs attention");
  });

  it("shows unreachable instance, unlinked sessions, and outdated skill with plain fixes at 80 and 120 cols", async () => {
    for (const width of [80, 120]) {
      const ctx = setup({
        columns: width,
        secondHub: "https://mit-ai.open-artifacts.app",
        st: {
          hub_version: "0.262.0",
          instances: [
            { name: "main", link: "connected", revoked: false, agents: 2 },
            {
              name: "mit-ai",
              link: "not_connected",
              revoked: false,
              agents: 0,
            },
          ],
          claude_sessions: [
            {
              name: "a",
              cwd: "/work/app",
              state: "unlinked",
              cause: "no_helper_call",
            },
            {
              name: "b",
              cwd: "/work/app",
              state: "unlinked",
              cause: "proof_refused",
            },
          ],
          namespaces: [{ namespace: NS, agents: [] }],
        },
      });
      // Write an out-of-date Codex skill for bus.example.com
      const folder = `open-artifacts-${hostSlug("bus.example.com")}`;
      const skillDir = join(ctx.userHome, ".codex", "skills", folder);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        `---\nname: ${folder}\nmetadata:\n  version: "0.258.0"\n---\n${SKILL_MARKER}\n# skill\n`,
      );

      expect(await statusCmd(ctx)).toBe(1);
      const lines = ctx.out();
      const joined = lines.join("\n");
      expect(lines[0]).toBe("oa-bus 0.262.0 · ▲ degraded · this MacBook");
      expect(joined).toContain("Needs attention (3)");
      expect(joined).toContain(
        "mit-ai.open-artifacts.app doesn't answer. Agents there won't get messages.",
      );
      expect(joined).toContain("Fix: check your network, then oa-bus doctor");
      expect(joined).toContain(
        '2 sessions here aren\'t linked: their page edits show "not linked".',
      );
      expect(joined).toContain(
        "Fix: run /mcp in that session.  Details: oa-bus status --links",
      );
      expect(joined).toContain("The Codex skill is out of date (0.258.0).");
      expect(joined).toContain("Fix: run oa-bus skill");

      // Needs attention appears between instances and Agents
      const attIdx = lines.findIndex((l) => l.includes("Needs attention (3)"));
      const agentsIdx = lines.findIndex((l) => l.startsWith("Agents"));
      expect(attIdx).toBeGreaterThan(0);
      expect(agentsIdx).toBeGreaterThan(attIdx);

      for (const l of lines)
        expect(cols(stripTerminalControls(l))).toBeLessThanOrEqual(width);
    }
  });

  it("daemon not running shows Needs attention with the start command", async () => {
    const noSvc = setup({ down: true, columns: 80 });
    expect(await statusCmd(noSvc)).toBe(1);
    expect(noSvc.out().join("\n")).toContain("Needs attention (1)");
    expect(noSvc.out().join("\n")).toContain("The bus daemon isn't running.");
    expect(noSvc.out().join("\n")).toContain("Fix: run oa-bus daemon");

    const withSvc = setup({ down: true, columns: 80, serviceKind: "launchd" });
    expect(await statusCmd(withSvc)).toBe(1);
    expect(withSvc.out().join("\n")).toContain("Fix: run oa-bus install");
  });

  it("late messages count only when well past normal delivery (>= 1 min)", async () => {
    const brief = setup({
      columns: 120,
      st: {
        late: [
          {
            from: "a",
            to: "b",
            at: 1_000_000,
            delay_ms: 8_000,
          },
        ],
      },
    });
    expect(await statusCmd(brief)).toBe(0);
    expect(brief.out().join("\n")).not.toContain("Needs attention");

    const oldDaemon = setup({
      columns: 120,
      st: {
        late: [{ from: "a", to: "b", at: 1_000_000 }],
      },
    });
    expect(await statusCmd(oldDaemon)).toBe(0);
    expect(oldDaemon.out().join("\n")).not.toContain("Needs attention");

    const veryLate = setup({
      columns: 120,
      st: {
        late: [
          {
            from: "a",
            to: "b",
            at: 1_000_000,
            delay_ms: LATE_ATTENTION_MS,
          },
        ],
      },
    });
    expect(await statusCmd(veryLate)).toBe(1);
    expect(veryLate.out().join("\n")).toContain("Needs attention (1)");
    expect(veryLate.out().join("\n")).toContain(
      "1 message delivered over a minute late.",
    );
    expect(veryLate.out().join("\n")).toContain(
      "Fix: run oa-bus status --messages",
    );
  });
});
