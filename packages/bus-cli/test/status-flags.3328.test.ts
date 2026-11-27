// #3328 S3: `oa-bus status` flags: --agents, --messages, --instances, --links, --json.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveInstance, writeFolders } from "@oa/bus-daemon";
import { describe, expect, it, vi } from "vitest";
import {
  type StatusJson,
  status as statusCmd,
} from "../src/commands/status.ts";
import { parse } from "../src/index.ts";
import { main } from "../src/main.ts";
import type { Style } from "../src/term.ts";
import { fakeCtx, HUB, NS, status, TOKEN } from "./fake.ts";

const NONE: Style = { color: "none", dark: true, utf8: true };

function setup(opts: {
  st?: Parameters<typeof status>[0];
  down?: boolean;
  secondHub?: string;
}) {
  const ctx = fakeCtx({
    style: NONE,
    version: "0.262.0",
    busCmd: "oa-bus",
    status: opts.down
      ? vi.fn(async () => {
          throw Object.assign(new Error("connect ECONNREFUSED"), {
            code: "ECONNREFUSED",
          });
        })
      : vi.fn(async () => status(opts.st)),
  });
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
        name: "work",
        hub: opts.secondHub,
        machine_id: "",
        label: "leonardos-macbook-pro",
        machine_token: `oa_machine_${"b".repeat(28)}7f3a`,
      },
      ctx.home,
    );
    writeFolders(
      { map: { "/code/work": "work", "/code/main": "main" }, no: {}, seen: {} },
      ctx.home,
    );
  }
  return ctx;
}

describe("oa-bus status flags parsing (#3328 S3)", () => {
  it("parses --agents, --messages, --instances, --links, --json", () => {
    expect(parse(["status", "--agents"])).toMatchObject({
      cmd: "status",
      agents: true,
    });
    expect(parse(["status", "--messages"])).toMatchObject({
      cmd: "status",
      messages: true,
    });
    expect(parse(["status", "--instances"])).toMatchObject({
      cmd: "status",
      instances: true,
    });
    expect(parse(["status", "--links"])).toMatchObject({
      cmd: "status",
      links: true,
    });
    expect(parse(["status", "--json"])).toMatchObject({
      cmd: "status",
      json: true,
    });
  });
});

describe("oa-bus status detail views (#3328 S3)", () => {
  it("--agents lists all agents across projects with full untruncated status text", async () => {
    const now = 1_700_000_000_000;
    const longLabel =
      "Implementing full end-to-end verification across every single workflow without truncating a single character";
    const workers = Array.from({ length: 12 }, (_, i) => ({
      name: `Worker-${String(i + 1).padStart(2, "0")}`,
      kind: "codex" as const,
      machine: "leonardos-macbook-pro",
      state: "live" as const,
      status: "working" as const,
      status_label: i === 0 ? longLabel : `task ${i + 1}`,
      status_at: new Date(now - (i + 1) * 60_000).toISOString(),
    }));
    const ctx = setup({
      st: {
        namespaces: [
          {
            namespace: NS,
            agents: [
              ...workers,
              {
                name: "pi-2",
                kind: "pi",
                machine: "Leo-Workstation",
                state: "live",
              },
            ],
          },
          {
            namespace: "github.com/org/other",
            agents: [
              {
                name: "Other-Agent",
                kind: "claude-code",
                machine: "Leo-Workstation",
                state: "live",
                status: "working",
                status_label: "other project task",
                status_at: new Date(now - 60_000).toISOString(),
              },
            ],
          },
        ],
      },
    });
    ctx.clock.t = now;
    expect(await statusCmd(ctx, { agents: true })).toBe(0);
    const out = ctx.out().join("\n");
    expect(out).toContain(longLabel);
    expect(out).toContain("Worker-12");
    expect(out).toContain("pi-2");
    expect(out).toContain("Other-Agent");
  });

  it("--messages lists late deliveries newest first, or says none", async () => {
    const now = 1_700_000_000_000;
    const empty = setup({});
    expect(await statusCmd(empty, { messages: true })).toBe(0);
    expect(empty.out()).toEqual(["No late messages."]);

    const ctx = setup({
      st: {
        late: [
          {
            from: "Alice",
            to: "Bob",
            excerpt: "older message",
            at: now - 10 * 60_000,
            delay_ms: 90_000,
          },
          {
            from: "Carol",
            to: "Dave",
            excerpt: "newer message",
            at: now - 2 * 60_000,
            delay_ms: 12_000,
          },
        ],
      },
    });
    ctx.clock.t = now;
    expect(await statusCmd(ctx, { messages: true })).toBe(0);
    const out = ctx.out();
    expect(out[0]).toBe("Late messages  2 messages");
    expect(out[1]).toContain("Carol → Dave");
    expect(out[1]).toContain("12s delay");
    expect(out[2]).toContain('"newer message"');
    expect(out[3]).toContain("Alice → Bob");
    expect(out[3]).toContain("1m 30s delay");
    expect(out[4]).toContain('"older message"');
  });

  it("--instances shows instances, guest sessions, and folders", async () => {
    const ctx = setup({
      secondHub: "https://work.example.com",
      st: {
        instances: [
          { name: "main", link: "connected", revoked: false, agents: 3 },
          {
            name: "work",
            link: "connected",
            revoked: false,
            agents: 1,
            guests: [{ name: "Visitor" }],
          },
        ],
      },
    });
    expect(await statusCmd(ctx, { instances: true })).toBe(0);
    const out = ctx.out().join("\n");
    expect(out).toContain("Instances");
    expect(out).toContain("main (main)");
    expect(out).toContain("https://bus.example.com");
    expect(out).toContain("work");
    expect(out).toContain("guest session: Visitor");
    expect(out).toContain("Folders");
    expect(out).toContain("/code/main → main");
    expect(out).toContain("/code/work → work");
  });

  it("--links shows live Claude sessions and fix when any are unlinked", async () => {
    const empty = setup({ st: { claude_sessions: [] } });
    expect(await statusCmd(empty, { links: true })).toBe(0);
    expect(empty.out()).toEqual(["No live Claude sessions."]);

    const ctx = setup({
      st: {
        claude_sessions: [
          { name: "ok-1", cwd: "/work/a", state: "linked" },
          {
            name: "bad-2",
            cwd: "/work/b",
            state: "unlinked",
            cause: "no_helper_call",
          },
        ],
      },
    });
    expect(await statusCmd(ctx, { links: true })).toBe(1);
    const out = ctx.out().join("\n");
    expect(out).toContain("Session links");
    expect(out).toContain("✓ linked  ok-1");
    expect(out).toContain("✗ unlinked  bad-2");
    expect(out).toContain("(no_helper_call)");
    expect(out).toContain("Fix: run /mcp in any unlinked session");
  });

  it("--json emits a stable documented JSON shape when working and when down", async () => {
    const now = 1_700_000_000_000;
    const ok = setup({
      st: {
        namespaces: [
          {
            namespace: NS,
            agents: [
              {
                name: "OA Bus L-2",
                kind: "codex",
                machine: "leonardos-macbook-pro",
                state: "live",
                status: "working",
                status_label: "shipping S3",
                status_at: new Date(now - 60_000).toISOString(),
              },
              {
                name: "pi-2",
                kind: "pi",
                machine: "leonardos-macbook-pro",
                state: "live",
              },
            ],
          },
          {
            namespace: "github.com/org/notes",
            agents: [
              {
                name: "notes-1",
                kind: "pi",
                machine: "leonardos-macbook-pro",
                state: "live",
              },
            ],
          },
        ],
      },
    });
    ok.clock.t = now;
    expect(await main(["status", "--json"], () => ok)).toBe(0);
    const parsed = JSON.parse(ok.out().join("\n")) as StatusJson;
    expect(parsed.v).toBe(1);
    expect(parsed.verdict).toBe("working");
    expect(parsed.daemon).toBe("up");
    expect(parsed.machine).toBe("leonardos-macbook-pro");
    expect(parsed.instances).toHaveLength(1);
    expect(parsed.instances[0]?.connected).toBe(true);
    expect(parsed.project.named).toBe(1);
    expect(parsed.project.unnamed_hidden).toBe(1);
    expect(parsed.project.agents).toHaveLength(2);
    expect(parsed.other_projects).toEqual([
      { namespace: "github.com/org/notes", name: "notes", count: 1 },
    ]);
    expect(parsed.agents_page_url).toBe(
      "https://bus.example.com/settings/agents",
    );
    expect(parsed.attention).toEqual([]);

    const down = setup({ down: true });
    expect(await main(["status", "--json"], () => down)).toBe(1);
    const parsedDown = JSON.parse(down.out().join("\n")) as StatusJson;
    expect(parsedDown.v).toBe(1);
    expect(parsedDown.verdict).toBe("down");
    expect(parsedDown.daemon).toBe("down");
    expect(parsedDown.attention).toHaveLength(1);
  });
});
