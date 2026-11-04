import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { revokedMarker, StartError } from "@oa/bus-daemon";
import { DaemonSilentError } from "@oa/bus-ipc";
import { newMachineToken } from "@oa/bus-protocol";
import { describe, expect, it, vi } from "vitest";
import { daemon } from "../src/commands/daemon.ts";
import { doctor } from "../src/commands/doctor.ts";
import { logs } from "../src/commands/logs.ts";
import { mcp } from "../src/commands/mcp.ts";
import { status as statusCmd } from "../src/commands/status.ts";
import { uninstall } from "../src/commands/uninstall.ts";
import type { Ctx } from "../src/context.ts";
import { main } from "../src/main.ts";
import { installAdapters } from "../src/steps/adapters.ts";
import { purge } from "../src/steps/purge.ts";
import {
  type Fake,
  fakeCtx,
  HUB,
  LABEL,
  NS,
  status,
  TOKEN,
  transcript,
} from "./fake.ts";

function approve(ctx: Fake, mode = 0o600) {
  mkdirSync(ctx.home, { recursive: true });
  const file = join(ctx.home, "machine.json");
  writeFileSync(
    file,
    JSON.stringify({
      hub: HUB,
      machine_id: "m",
      label: LABEL,
      machine_token: TOKEN,
    }),
  );
  chmodSync(file, mode);
}
const up = (over = {}) => vi.fn(async () => status(over));
const noToken = (ctx: Fake) =>
  expect([...ctx.out(), ...ctx.err()].join("\n")).not.toContain(
    TOKEN.slice(11),
  );

const ALL = (c: string) => ["claude", "opencode", "pi"].includes(c);
const launchd = (removed = true) => ({
  kind: "launchd" as const,
  ensure: vi.fn(async () => ({})),
  remove: vi.fn(async () => (removed ? { unit: "launchd" as const } : {})),
  cli: () => ["oa-bus"],
});
/** exec: `opencode --version` answers `version`; `claude mcp` fails so configs are files. */
const execWith = (version = "2.0.32", restart = 0) =>
  vi.fn(async (cmd: string, args: string[]) =>
    cmd === "opencode" && args[0] === "--version"
      ? { code: 0, stdout: `opencode v${version}\n`, stderr: "" }
      : cmd === "opencode" && args[0] === "service"
        ? { code: restart, stdout: "", stderr: restart ? "not running" : "" }
        : cmd === "claude"
          ? { code: 1, stdout: "", stderr: "no" }
          : { code: 0, stdout: "", stderr: "" },
  );
/** Wires every harness into the fake homes, as install would. */
async function wire(ctx: Fake, which = ALL) {
  await installAdapters({
    home: ctx.userHome,
    busHome: ctx.home,
    busBin: ["/usr/local/bin/oa-bus"],
    assets: { pi: "P", opencodePlugin: "J" },
    which,
    exec: execWith(),
  });
}
const row = (
  name: string,
  kind: "claude-code" | "opencode" | "pi",
  machine = LABEL,
  state: "live" | "queued" = "live",
) => ({ name, kind, machine, state });

describe("status and doctor: not running, not responding, reconnecting (#274)", () => {
  const silent = () => new DaemonSilentError("daemon did not answer status");
  const refused = () =>
    Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  const missing = () =>
    Object.assign(new Error("connect ENOENT"), { code: "ENOENT" });
  const stalled = [
    "[[danger]]×[[/danger]]  Daemon not responding",
    "   It is running but not answering. Try again, or run npx @open-artifacts/bus doctor.",
  ];

  it.each([
    ["missing socket", missing],
    ["refused", refused],
  ])("%s: not running, with no retry", async (_n, err) => {
    const st = vi.fn(async () => {
      throw err();
    });
    const ctx = fakeCtx({ status: st });
    approve(ctx);
    expect(await statusCmd(ctx)).toBe(1);
    expect(ctx.all()).toContain("[[danger]]×[[/danger]]  Daemon not running");
    expect(ctx.all().join("\n")).not.toContain("not responding");
    expect(st).toHaveBeenCalledTimes(1);
  });

  it("accepts but silent: not responding, after one retry", async () => {
    const st = vi.fn(async () => {
      throw silent();
    });
    const ctx = fakeCtx({ status: st });
    approve(ctx);
    expect(await statusCmd(ctx)).toBe(1);
    expect(ctx.all().slice(-2)).toEqual(stalled);
    expect(ctx.all().join("\n")).not.toContain("not running");
    expect(st).toHaveBeenCalledTimes(2);
    expect(ctx.sleep).toHaveBeenCalledWith(500);
  });

  it("connection closed, an error frame or garbage all count as not responding", async () => {
    for (const msg of [
      "daemon connection closed",
      "daemon refused status: nope",
      "Unexpected token",
    ]) {
      const ctx = fakeCtx({
        status: vi.fn(async () => {
          throw new DaemonSilentError(msg);
        }),
      });
      approve(ctx);
      expect(await statusCmd(ctx)).toBe(1);
      expect(ctx.all().slice(-2)).toEqual(stalled);
    }
  });

  it("the retry waits 500 ms and is bounded to 1.5 s", async () => {
    const st = vi.fn(async (_o: { timeoutMs?: number }) => {
      throw silent();
    });
    const ctx = fakeCtx({ status: st as unknown as Ctx["status"] });
    approve(ctx);
    await statusCmd(ctx);
    expect(st.mock.calls.map((c) => c[0].timeoutMs)).toEqual([3000, 1500]);
  });

  it("slow on the first try, answering on the retry: normal output", async () => {
    const st = vi
      .fn()
      .mockRejectedValueOnce(silent())
      .mockResolvedValue(status({}));
    const ctx = fakeCtx({ service: launchd(), status: st });
    approve(ctx);
    expect(await statusCmd(ctx)).toBe(0);
    expect(ctx.all().join("\n")).not.toContain("not responding");
    expect(st).toHaveBeenCalledTimes(2);
  });

  it("link down: reconnecting, daemon running", async () => {
    const ctx = fakeCtx({
      service: launchd(),
      status: up({
        hub: "connecting",
        hub_error: "ECONNREFUSED",
        hub_ever: true,
        hub_since: 1_000_000 - 120_000,
      }),
    });
    approve(ctx);
    expect(await statusCmd(ctx)).toBe(1);
    const out = ctx.all().join("\n");
    expect(out).toContain("reconnecting");
    expect(out).toContain("Daemon running as a launchd service");
    expect(out).not.toContain("not responding");
    expect(out).not.toContain("not running");
  });

  it("doctor: refused is not running; silent twice is not responding; a late answer passes", async () => {
    const d1 = fakeCtx({
      status: vi.fn(async () => {
        throw refused();
      }),
    });
    await doctor(d1);
    expect(d1.all()).toContain("[[danger]]×[[/danger]]  Daemon is not running");

    const st = vi.fn(async () => {
      throw silent();
    });
    const d2 = fakeCtx({ status: st });
    await doctor(d2);
    expect(d2.all()).toContain(
      "[[danger]]×[[/danger]]  Daemon is not responding",
    );
    expect(st).toHaveBeenCalledTimes(2);

    const d3 = fakeCtx({
      service: launchd(),
      status: vi
        .fn()
        .mockRejectedValueOnce(silent())
        .mockResolvedValue(status({})),
    });
    await doctor(d3);
    expect(d3.all().join("\n")).not.toContain("Daemon is not");
  });
});

describe("status: transcript state 7", () => {
  const blocks = transcript("## 7. status");
  const healthy = status({
    namespaces: [
      {
        namespace: NS,
        agents: [
          row("oa-team-platform", "claude-code", "leo-mac-mini", "queued"),
          row("oa-team-design", "claude-code"),
          row("oa-team-backend", "claude-code"),
        ],
      },
      {
        namespace: "github.com/leourbina/notes",
        agents: [row("notes-writer", "pi")],
      },
    ],
  });

  it("connected and healthy: rows, daemon, one roster per namespace; exit 0", async () => {
    const ctx = fakeCtx({
      service: launchd(),
      status: vi.fn(async () => healthy),
    });
    approve(ctx);
    expect(await statusCmd(ctx)).toBe(0);
    expect(ctx.all()).toEqual(blocks[0]);
    expect(ctx.all()[2]).toBe(
      "Hub      bus.example.com  [[success]]● connected[[/success]]",
    );
    noToken(ctx);
  });

  it("hub not reachable: no roster rows; exit 1", async () => {
    const ctx = fakeCtx({
      service: launchd(),
      status: up({
        hub: "connecting",
        hub_error: "ECONNREFUSED",
        hub_ever: true,
        hub_since: 1_000_000 - 120_000,
      }),
    });
    approve(ctx);
    expect(await statusCmd(ctx)).toBe(1);
    expect(ctx.all()).toEqual(blocks[1]);
  });

  it("daemon not running; exit 1", async () => {
    const ctx = fakeCtx({ service: launchd() });
    approve(ctx);
    expect(await statusCmd(ctx)).toBe(1);
    expect(ctx.all()).toEqual(blocks[2]);
  });

  it("not registered: no Hub or Machine rows; exit 1", async () => {
    const ctx = fakeCtx();
    expect(await statusCmd(ctx)).toBe(1);
    expect(ctx.all()).toEqual(blocks[3]);
  });

  it("names machine.json's hub, not OA_BUS_INSTANCE", async () => {
    const ctx = fakeCtx({ env: { OA_BUS_INSTANCE: "https://other.example.org" } });
    approve(ctx);
    await statusCmd(ctx);
    expect(ctx.all()[2]).toBe("Hub      bus.example.com");
  });

  describe("hub link state (C20)", () => {
    const hubRow = async (over: Parameters<typeof status>[0], ctxOver = {}) => {
      const ctx = fakeCtx({ status: up(over), ...ctxOver });
      approve(ctx);
      await statusCmd(ctx);
      return ctx.all()[2];
    };
    const down = (agoMs: number) => ({
      hub: "connecting" as const,
      hub_ever: true,
      hub_since: 1_000_000 - agoMs,
    });
    const R = "Hub      bus.example.com  [[warning]]○ reconnecting[[/warning]]";
    it("reconnecting under 1 min has no duration", async () => {
      expect(await hubRow(down(59_999))).toBe(R);
    });
    it("reconnecting 2 min", async () => {
      expect(await hubRow(down(2 * 60_000 + 30_000))).toBe(
        `${R}  [[muted]]for 2 min[[/muted]]`,
      );
    });
    it("reconnecting 61 min reads 1 h", async () => {
      expect(await hubRow(down(61 * 60_000))).toBe(
        `${R}  [[muted]]for 1 h[[/muted]]`,
      );
    });
    it("pins the 59 min and 60 min boundaries", async () => {
      expect(await hubRow(down(59 * 60_000 + 59_000))).toBe(
        `${R}  [[muted]]for 59 min[[/muted]]`,
      );
      expect(await hubRow(down(60 * 60_000))).toBe(
        `${R}  [[muted]]for 1 h[[/muted]]`,
      );
    });
    it("connecting: never connected since the daemon started", async () => {
      expect(await hubRow({ hub: "connecting", hub_ever: false })).toBe(
        "Hub      bus.example.com  [[warning]]○ connecting[[/warning]]",
      );
    });
    it("an older daemon without the fields: connected, or connecting with no duration", async () => {
      expect(await hubRow({})).toContain("● connected");
      expect(await hubRow({ hub: "connecting" })).toBe(
        "Hub      bus.example.com  [[warning]]○ connecting[[/warning]]",
      );
    });
    it("a long host is cut so the row is at most 80", async () => {
      const ctx = fakeCtx({ status: up(down(2 * 60_000)) });
      approve(ctx);
      writeFileSync(
        join(ctx.home, "machine.json"),
        JSON.stringify({
          machine_id: "m",
          label: LABEL,
          machine_token: TOKEN,
          hub: `https://${"a".repeat(30)}.${"b".repeat(60)}.example.com`,
        }),
      );
      await statusCmd(ctx);
      const line = ctx.all()[2] ?? "";
      expect(line).toContain("…");
      expect(line).toContain("reconnecting");
      expect(line.replace(/\[\[\/?\w+\]\]/g, "").length).toBeLessThanOrEqual(
        80,
      );
    });
  });

  describe("late deliveries (C17)", () => {
    const Q = "Can you regenerate the API reference pag…";
    const late = (from: string, to: string, agoMs: number, excerpt = Q) => ({
      from,
      to,
      ...(excerpt ? { excerpt } : {}),
      at: 1_000_000 - agoMs,
    });
    const run = async (l: ReturnType<typeof late>[]) => {
      const ctx = fakeCtx({
        service: launchd(),
        status: vi.fn(async () => ({ ...healthy, late: l })),
      });
      approve(ctx);
      const code = await statusCmd(ctx);
      return { code, out: ctx.all(), base: blocks[0] as string[] };
    };

    it("follows the last table and its footnote, newest first; exit unaffected", async () => {
      const { code, out, base } = await run([
        late(
          "oa-team-design",
          "oa-team-frontend",
          14 * 60_000,
          "The Machines page empty state is ready f…",
        ),
        late("oa-team-backend", "oa-team-e0", 2 * 60_000),
      ]);
      expect(code).toBe(0);
      expect(out.slice(0, base.length)).toEqual(base);
      const section = out.slice(base.length);
      expect(section[0]).toBe("");
      expect(section.slice(1)).toEqual(blocks[5]);
    });

    it("singular, and a row with no excerpt has no quote line", async () => {
      const { out, base } = await run([late("a", "b", 10_000, "")]);
      expect(out.slice(base.length)).toEqual([
        "",
        "1 message delivered late  [[muted]]last hour[[/muted]]",
        "  a to b  [[muted]]now[[/muted]]",
      ]);
    });

    it("is absent at 0", async () => {
      expect((await run([])).out).toEqual(blocks[0]);
    });

    it("cuts long names so no row passes 80 columns", async () => {
      const untag = (l: string) => l.replace(/\[\[\/?[a-z]+\]\]/g, "");
      for (const [from, to] of [
        ["f".repeat(64), "t".repeat(64)],
        ["short", "t".repeat(128)],
        ["f".repeat(128), "x"],
      ]) {
        const { out, base } = await run([late(from, to, 59 * 60_000)]);
        for (const line of out.slice(base.length))
          expect(untag(line).length).toBeLessThanOrEqual(80);
        const row = untag(out[base.length + 2] as string);
        expect(row).toHaveLength(80);
        expect(row).toContain(" to ");
      }
    });

    it("strips terminal controls from the quote", async () => {
      const { out } = await run([late("a", "b", 0, "hi\x1b]52;c;x\x07 there")]);
      expect(out.at(-1)).toBe('    "hi there"');
    });
  });

  it("revoked: the daemon's marker; exit 1", async () => {
    const ctx = fakeCtx({ status: up() });
    approve(ctx);
    writeFileSync(join(ctx.home, "revoked"), "{}");
    expect(await statusCmd(ctx)).toBe(1);
    expect(ctx.all()).toEqual(blocks[4]);
  });
});

describe("status and doctor: update available and unknown kinds (C26h)", () => {
  const draft = transcript("## 7. status").at(-1) as string[];
  const run = async (hub_version?: string, version = "0.46.3") => {
    const ctx = fakeCtx({
      service: launchd(),
      status: up({ version, ...(hub_version ? { hub_version } : {}) }),
    });
    approve(ctx);
    expect(await statusCmd(ctx)).toBe(0);
    return ctx.all();
  };
  const down = {
    hub: "connecting" as const,
    hub_ever: true,
    hub_error: "ECONNREFUSED",
    version: "0.46.3",
    hub_version: "0.47.0",
  };

  it("says so when the hub is newer, as the transcript shows", async () => {
    const out = await run("0.47.0");
    const at = out.indexOf(draft[0] as string);
    expect(out.slice(at, at + 3)).toEqual(draft);
    expect(await run("1.0.0", "0.46.3-rc.1")).toContain(
      "[[warning]]![[/warning]]  Update available: 1.0.0 (this machine runs 0.46.3-rc.1)",
    );
  });

  it("compares and shows the core version only", async () => {
    expect(await run("0.47.0-abc1234")).toContain(
      "[[warning]]![[/warning]]  Update available: 0.47.0 (this machine runs 0.46.3)",
    );
    expect(await run("0.47.0+build.7")).toContain(
      "[[warning]]![[/warning]]  Update available: 0.47.0 (this machine runs 0.46.3)",
    );
    // A pre-release of the same core is never newer, on either side.
    for (const [hub, mine] of [
      ["0.47.0", "0.47.0-rc.1"],
      ["0.47.0-abc1234", "0.47.0-rc.1"],
      ["0.47.0-abc1234", "0.47.0"],
    ])
      expect((await run(hub, mine)).join("\n")).not.toContain(
        "Update available",
      );
  });

  it("stays within 80 columns at its longest", async () => {
    const out = await run(
      "1234567890123.1234567890123.1234567890123-sha",
      "1234567890123.1234567890123.1234567890122-rc.1+build.9",
    );
    const line = out.find((l) => l.includes("Update available")) ?? "";
    const plain = line.replace(/\[\[\/?\w+\]\]/g, "");
    expect([...plain].length).toBe(80);
    expect(plain).toBe(
      "!  Update available: 123456789…567890123 (this machine runs 123456789…1+build.9)",
    );
  });

  it("says nothing while the hub link is down", async () => {
    const ctx = fakeCtx({ service: launchd(), status: up(down) });
    approve(ctx);
    expect(await statusCmd(ctx)).toBe(1);
    expect(ctx.all().join("\n")).not.toContain("Update available");
    expect(ctx.all().join("\n")).toContain("Hub not reachable");
    const doc = fakeCtx({
      nodeVersion: "v22.11.0",
      service: launchd(),
      status: up(down),
      fetch: vi.fn(async () => new Response("ok")) as unknown as typeof fetch,
      which: () => false,
    });
    approve(doc);
    await doctor(doc);
    expect(doc.all().join("\n")).not.toContain("Update available");
  });

  it("is silent when equal, older or unknown", async () => {
    for (const hub of [
      "0.47.0",
      "0.47.0+build.7",
      "0.46.2",
      "0.9.99",
      "0.47.0-abc1234",
      undefined,
      "dev",
      "e2e",
      "\x1b]52;c;aGk=\x07",
    ]) {
      const out = await run(hub, "0.47.0");
      expect(out.join("\n")).not.toContain("Update available");
    }
  });

  it("doctor warns once and counts it", async () => {
    const ctx = fakeCtx({
      nodeVersion: "v22.11.0",
      service: launchd(),
      status: up({ version: "0.46.3", hub_version: "0.47.0" }),
      fetch: vi.fn(async () => new Response("ok")) as unknown as typeof fetch,
      which: () => false,
    });
    approve(ctx);
    expect(await doctor(ctx)).toBe(0);
    const out = ctx.all();
    expect(out.filter((l) => l.includes("Update available"))).toEqual([
      draft[1],
    ]);
    expect(out).toContain(draft[2]);
    expect(out.at(-1)).toBe("[[muted]]1 warning, 4 passed.[[/muted]]");
  });

  it("status shows a made-up kind as itself", async () => {
    const ctx = fakeCtx({
      service: launchd(),
      status: up({
        namespaces: [
          {
            namespace: NS,
            agents: [
              { name: "zz-1", kind: "zz", machine: LABEL, state: "live" },
            ],
          },
        ],
      }),
    });
    approve(ctx);
    expect(await statusCmd(ctx)).toBe(0);
    expect(ctx.all().find((l) => l.includes("zz-1"))).toMatch(
      /^ {2}zz-1 {16}zz {11}leo-macbook-pro/,
    );
  });
});

describe("update available without hub_version (C26i)", () => {
  const LINE = (x: string, y: string) =>
    `[[warning]]![[/warning]]  Update available: ${x} (this machine runs ${y})`;
  const health = (version: string) =>
    vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe(`${HUB}/healthz`);
      return Response.json({ version });
    }) as unknown as typeof fetch;
  const text = async (
    cmd: "status" | "doctor",
    over: Partial<Ctx>,
    daemonV = "0.44.1",
  ) => {
    const ctx = fakeCtx({
      service: launchd(),
      status: up({ version: daemonV }),
      which: () => false,
      nodeVersion: "v22.11.0",
      ...over,
    });
    approve(ctx);
    await (cmd === "status" ? statusCmd(ctx) : doctor(ctx));
    return ctx.all();
  };

  for (const cmd of ["status", "doctor"] as const) {
    it(`${cmd}: healthz newer than an old daemon shows the line`, async () => {
      const out = await text(cmd, { fetch: health("0.49.0") });
      expect(out).toContain(LINE("0.49.0", "0.44.1"));
    });

    it(`${cmd}: healthz equal, older or failing is silent`, async () => {
      for (const f of [
        health("0.44.1"),
        health("0.40.0"),
        vi.fn(async () => new Response("no", { status: 500 })),
        vi.fn(async () => new Response("not json")),
        vi.fn(async () => {
          throw new Error("down");
        }),
      ])
        expect(
          (await text(cmd, { fetch: f as unknown as typeof fetch })).join("\n"),
        ).not.toContain("Update available");
    });

    it(`${cmd}: the CLI newer than the daemon shows the line`, async () => {
      const out = await text(cmd, {
        version: "0.49.0",
        fetch: health("0.45.0"),
      });
      expect(out).toContain(LINE("0.49.0", "0.44.1"));
    });

    it(`${cmd}: the newest of hub and CLI is the target`, async () => {
      const out = await text(cmd, {
        version: "0.46.0",
        fetch: health("0.48.0"),
      });
      expect(out).toContain(LINE("0.48.0", "0.44.1"));
    });
  }

  it("a slow healthz is silent within the bound", async () => {
    vi.useFakeTimers();
    try {
      const f = vi.fn(
        (_u: unknown, init?: RequestInit) =>
          new Promise((_, reject) =>
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("aborted")),
            ),
          ),
      );
      const done = text("status", { fetch: f as unknown as typeof fetch });
      await vi.advanceTimersByTimeAsync(1500);
      expect((await done).join("\n")).not.toContain("Update available");
      expect(f).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("doctor follows redirects for reachability but trusts only the hub's origin", async () => {
    const seen: (RequestInit | undefined)[] = [];
    const via = (url: string) =>
      vi.fn(async (_u: unknown, init?: RequestInit) => {
        seen.push(init);
        const res = Response.json({ version: "0.49.0" });
        Object.defineProperty(res, "url", { value: url });
        return res;
      }) as unknown as typeof fetch;
    const off = await text("doctor", {
      fetch: via("https://evil.example/healthz"),
    });
    expect(off.join("\n")).not.toContain("Update available");
    expect(off.join("\n")).toContain("Hub reachable");
    const on = await text("doctor", { fetch: via(`${HUB}/healthz`) });
    expect(on).toContain(LINE("0.49.0", "0.44.1"));
    expect(seen.every((i) => i?.redirect === undefined)).toBe(true);
  });

  it("doctor asks /healthz once", async () => {
    const f = health("0.49.0");
    await text("doctor", { fetch: f });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("status fetches /healthz once, even when the daemon reports hub_version or the link is down", async () => {
    for (const status of [
      up({ version: "0.44.1", hub_version: "0.44.1" }),
      up({ hub: "connecting", version: "0.44.1" }),
    ]) {
      const f = health("0.44.1");
      const ctx = fakeCtx({ service: launchd(), status, fetch: f });
      approve(ctx);
      await statusCmd(ctx);
      expect(f).toHaveBeenCalledTimes(1);
    }
  });
});

describe("hub problem from /healthz (#294)", () => {
  const FAIL =
    "[[danger]]×[[/danger]]  The instance reports a problem: test_card_key";
  const FIX = ["   Ask the instance's admin to check it."];
  const hz = (body: unknown) =>
    vi.fn(async () => Response.json(body)) as unknown as typeof fetch;
  const run = async (
    cmd: "status" | "doctor",
    f: typeof fetch,
    over: Parameters<typeof up>[0] = {},
  ) => {
    const ctx = fakeCtx({
      service: launchd(),
      status: up(over),
      fetch: f,
      which: () => false,
      nodeVersion: "v22.11.0",
    });
    approve(ctx);
    const code = await (cmd === "status" ? statusCmd(ctx) : doctor(ctx));
    return { code, out: ctx.all() };
  };
  const bad = { version: "0.46.3", problem: "test_card_key" };

  for (const [name, over] of [
    ["link up", {}],
    ["link down", { hub: "reconnecting", hub_ever: true }],
  ] as const) {
    it(`status shows it with the ${name}, after the hub and daemon rows, and exits 1`, async () => {
      const { code, out } = await run("status", hz(bad), over);
      expect(code).toBe(1);
      const i = out.indexOf(FAIL);
      expect(i).toBeGreaterThan(0);
      expect(out.slice(i + 1, i + 2)).toEqual(FIX);
      expect(out[i - 1]).toContain("Daemon running");
    });
  }

  it("doctor fails the hub section with it", async () => {
    const { code, out } = await run("doctor", hz(bad));
    expect(code).toBe(1);
    const i = out.indexOf(FAIL);
    expect(out[i - 1]).toContain("Hub reachable");
    expect(out.slice(i + 1, i + 2)).toEqual(FIX);
    expect(out.at(-1)).toContain("1 failed");
  });

  it("an unknown problem prints generically", async () => {
    for (const cmd of ["status", "doctor"] as const) {
      const { out } = await run(cmd, hz({ problem: "disk_full" }));
      expect(out.join("\n")).toContain(
        "The instance reports a problem: disk_full",
      );
      expect(out.join("\n")).not.toContain("ob:setup");
    }
  });

  it("a hostile problem is stripped and capped", async () => {
    const evil = `\x1b]52;c;aGk=\x07\x1b[31mX${"y".repeat(500)}\n\r`;
    for (const cmd of ["status", "doctor"] as const) {
      const { out } = await run(cmd, hz({ problem: evil }));
      const line = out.find((l) => l.includes("reports a problem")) as string;
      expect(line).not.toContain("\x1b");
      expect(line).not.toContain("\x07");
      expect(line).not.toContain("\n");
      expect(line).not.toContain("\r");
      expect(line).not.toContain("52;c");
      expect(line.length).toBeLessThan(120);
    }
  });

  it("no problem, an empty one or a failed fetch is silent and exits 0", async () => {
    for (const f of [
      hz({ version: "0.46.3" }),
      hz({ problem: "" }),
      hz({ problem: 7 }),
      vi.fn(async () => new Response("no", { status: 500 })),
      vi.fn(async () => new Response("not json")),
      vi.fn(async () => {
        throw new Error("down");
      }),
    ]) {
      const { code, out } = await run("status", f as unknown as typeof fetch);
      expect(code).toBe(0);
      expect(out.join("\n")).not.toContain("The hub ");
      const d = await run("doctor", f as unknown as typeof fetch);
      expect(d.out.join("\n")).not.toContain("The hub ");
    }
  });

  it("status starts /healthz before it asks the daemon, so the two overlap", async () => {
    const f = vi.fn(async () => Response.json({})) as unknown as typeof fetch;
    const calls: string[] = [];
    const ctx = fakeCtx({
      service: launchd(),
      fetch: vi.fn(async (...a: Parameters<typeof fetch>) => {
        calls.push("healthz");
        return f(...a);
      }) as unknown as typeof fetch,
      status: vi.fn(async () => {
        calls.push("daemon");
        return status({});
      }),
    });
    approve(ctx);
    await statusCmd(ctx);
    expect(calls).toEqual(["healthz", "daemon"]);
  });

  it("status stays within the 1.5 s bound on a hung hub, with one request", async () => {
    vi.useFakeTimers();
    try {
      const f = vi.fn(
        (_u: unknown, init?: RequestInit) =>
          new Promise((_, reject) =>
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("aborted")),
            ),
          ),
      );
      const ctx = fakeCtx({ service: launchd(), status: up() });
      Object.assign(ctx, { fetch: f });
      approve(ctx);
      const state = { done: false };
      const p = statusCmd(ctx).then((c) => {
        state.done = true;
        return c;
      });
      await vi.advanceTimersByTimeAsync(1499);
      expect(state.done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await p).toBe(0);
      expect(f).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("doctor: transcript state 8", () => {
  const blocks = transcript("## 8. doctor");
  const healthz = (ok: boolean) =>
    vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe(`${HUB}/healthz`);
      if (!ok)
        throw Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ECONNREFUSED" },
        });
      return new Response("ok");
    }) as unknown as typeof fetch;

  it("all 8 checks pass; exit 0; read-only", async () => {
    const ctx = fakeCtx({
      nodeVersion: "v22.11.0",
      service: launchd(),
      status: up(),
      fetch: healthz(true),
      which: ALL,
      exec: execWith(),
    });
    approve(ctx);
    await wire(ctx);
    mkdirSync(join(ctx.userHome, ".claude"), { recursive: true });
    writeFileSync(
      join(ctx.userHome, ".claude/settings.json"),
      JSON.stringify({ isolatePeerMachines: false }),
    );
    const before = readdirSync(ctx.home);
    vi.mocked(ctx.exec).mockClear();
    expect(await doctor(ctx)).toBe(0);
    expect(ctx.all()).toEqual(blocks[0]);
    expect(readdirSync(ctx.home)).toEqual(before);
    for (const [cmd, args] of vi.mocked(ctx.exec).mock.calls)
      expect([cmd, ...args]).toEqual(["opencode", "--version"]);
    // Only the token's tail.
    expect(ctx.all().join("\n")).not.toContain(TOKEN.slice(11, 30));
  });

  it("a run with problems; exit 1 on any ×", async () => {
    const ctx = fakeCtx({
      nodeVersion: "v22.11.0",
      fetch: healthz(false),
      which: ALL,
      exec: execWith("1.4.2"),
    });
    approve(ctx);
    await wire(ctx, (c) => c === "claude");
    expect(await doctor(ctx)).toBe(1);
    expect(ctx.all()).toEqual(blocks[1]);
  });

  it("each check's failure line", async () => {
    const ctx = fakeCtx({
      nodeVersion: "v20.9.0",
      which: (c) => c === "opencode",
      exec: vi.fn(async () => ({ code: 1, stdout: "", stderr: "" })),
    });
    expect(await doctor(ctx)).toBe(1);
    expect(ctx.all()).toEqual([
      "oa-bus 0.1.0",
      "",
      "[[danger]]×[[/danger]]  Node 20.9.0 is too old (needs 22 or newer)",
      "   Install Node 22 or newer, then run npx @open-artifacts/bus doctor again.",
      "[[danger]]×[[/danger]]  No credentials at ~/.oa-bus/machine.json",
      "   Run npx @open-artifacts/bus to approve this machine.",
      "[[danger]]×[[/danger]]  Daemon is not running",
      "   Run npx @open-artifacts/bus to restart it.",
      "[[warning]]![[/warning]]  OpenCode version unknown",
      "   Run opencode --version to check it, then npx @open-artifacts/bus install again.",
      "",
      "[[muted]]3 failed, 1 warning.[[/muted]]",
    ]);
  });

  it("Codex (C26e): wiring, wake binary, Codex home and sandbox", async () => {
    const ctx = fakeCtx({
      nodeVersion: "v22.11.0",
      status: up(),
      fetch: healthz(true),
      // Installed from a shell on the default Codex home.
      service: { ...launchd(), env: () => ({ PATH: "/usr/bin" }) },
      exec: execWith(),
    });
    const codexHome = join(ctx.userHome, "work/codex");
    const binDir = join(ctx.userHome, "bin");
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(binDir);
    writeFileSync(join(binDir, "codex"), "#!/bin/sh\n");
    chmodSync(join(binDir, "codex"), 0o755);
    writeFileSync(
      join(codexHome, "config.toml"),
      'sandbox_mode = "danger-full-access"\n',
    );
    ctx.env = { CODEX_HOME: codexHome, PATH: binDir };
    approve(ctx);
    await installAdapters({
      home: ctx.userHome,
      busHome: ctx.home,
      env: ctx.env,
      busBin: ["/usr/local/bin/oa-bus"],
      assets: { pi: "P", opencodePlugin: "J" },
      which: () => false,
      exec: execWith(),
    });
    const before = readdirSync(codexHome).sort();
    expect(await doctor(ctx)).toBe(0);
    expect(ctx.all()).toEqual(
      expect.arrayContaining([
        "[[success]]✓[[/success]]  Codex wired",
        "[[success]]✓[[/success]]  Codex wakes with ~/bin/codex",
        "[[warning]]![[/warning]]  The daemon reads Codex from ~/.codex, this shell from ~/work/codex",
        "   Run npx @open-artifacts/bus install from this shell to match it.",
        "[[warning]]![[/warning]]  Codex runs with danger-full-access, so one thread can pose as another",
        "   Set sandbox_mode to workspace-write in ~/work/codex/config.toml.",
      ]),
    );
    expect(readdirSync(codexHome).sort()).toEqual(before);
  });

  it("Codex: a writable root inside the Codex home warns too", async () => {
    const ctx = fakeCtx({ nodeVersion: "v22.11.0", exec: execWith() });
    const codexHome = join(ctx.userHome, ".codex");
    mkdirSync(codexHome);
    writeFileSync(
      join(codexHome, "config.toml"),
      '[sandbox_workspace_write]\nwritable_roots = ["~/.codex/sessions"]\n',
    );
    await doctor(ctx);
    expect(ctx.all()).toContain(
      "[[warning]]![[/warning]]  Codex lets threads write ~/.codex, so one thread can pose as another",
    );
  });

  it("Codex: writable_roots over the Codex home warns like full access", async () => {
    const ctx = fakeCtx({ nodeVersion: "v22.11.0", exec: execWith() });
    const codexHome = join(ctx.userHome, ".codex");
    mkdirSync(codexHome);
    writeFileSync(
      join(codexHome, "config.toml"),
      '[sandbox_workspace_write]\nwritable_roots = ["~"]\n',
    );
    await doctor(ctx);
    expect(ctx.all()).toEqual(
      expect.arrayContaining([
        "[[warning]]![[/warning]]  Codex lets threads write ~/.codex, so one thread can pose as another",
        "   Remove the entry that covers it from writable_roots in ~/.codex/config.toml.",
      ]),
    );
  });

  it("Codex without a binary to wake with, or not wired", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ob-codex-home-"));
    const ctx = fakeCtx({
      nodeVersion: "v22.11.0",
      env: { CODEX_HOME: codexHome },
      exec: execWith(),
    });
    expect(await doctor(ctx)).toBe(1);
    expect(ctx.all()).toEqual(
      expect.arrayContaining([
        "[[danger]]×[[/danger]]  Codex is not wired",
        "   Run npx @open-artifacts/bus to wire it.",
        "[[warning]]![[/warning]]  No codex binary found, so idle Codex threads are not woken",
        "   Install the Codex CLI, then run npx @open-artifacts/bus install again.",
      ]),
    );
    // No service: nothing to compare the Codex home with.
    expect(ctx.all().join("\n")).not.toContain("The daemon reads Codex");
  });

  it("revoked credentials, and Claude ignoring other machines", async () => {
    const ctx = fakeCtx({
      nodeVersion: "v22.11.0",
      status: up(),
      fetch: healthz(true),
      which: (c) => c === "claude",
      exec: execWith(),
    });
    approve(ctx);
    writeFileSync(join(ctx.home, "revoked"), "{}");
    await wire(ctx, (c) => c === "claude");
    mkdirSync(join(ctx.userHome, ".claude"), { recursive: true });
    writeFileSync(
      join(ctx.userHome, ".claude/settings.json"),
      JSON.stringify({ isolatePeerMachines: true }),
    );
    expect(await doctor(ctx)).toBe(1);
    expect(ctx.all()).toEqual(
      expect.arrayContaining([
        "[[danger]]×[[/danger]]  This machine was revoked",
        "   Run npx @open-artifacts/bus install to approve it again.",
        "[[warning]]![[/warning]]  Claude Code ignores messages from other machines",
        "   Set isolatePeerMachines to false in ~/.claude/settings.json.",
      ]),
    );
    // No service: the daemon line is the second warning.
    expect(ctx.all().at(-1)).toBe(
      "[[muted]]1 failed, 2 warnings, 3 passed.[[/muted]]",
    );
  });

  it("a daemon with no service is a warning: exit 0", async () => {
    const ctx = fakeCtx({
      nodeVersion: "v22.11.0",
      status: up(),
      fetch: healthz(true),
    });
    approve(ctx);
    expect(await doctor(ctx)).toBe(0);
    expect(ctx.all()).toEqual(
      expect.arrayContaining([
        "[[warning]]![[/warning]]  Daemon running, but no service will restart it after a reboot.",
        "   Run npx @open-artifacts/bus install.",
        "[[muted]]1 warning, 3 passed.[[/muted]]",
      ]),
    );
  });
});

describe("uninstall: transcript states 9 and 10", () => {
  async function installed(ctx: Fake) {
    approve(ctx);
    await wire(ctx);
    for (const f of [
      "install.json",
      "sent.json",
      "claude-held.json",
      "opencode-uncertain.json",
    ])
      writeFileSync(join(ctx.home, f), "{}");
    mkdirSync(join(ctx.home, "logs"));
    writeFileSync(join(ctx.home, "logs/daemon.log"), "x\n");
  }

  it("9: removes the service and the wiring, keeps the credentials; exit 0", async () => {
    const ctx = fakeCtx({ service: launchd(), which: ALL, exec: execWith() });
    await installed(ctx);
    expect(await uninstall({ purge: false }, ctx)).toBe(0);
    expect(ctx.all()).toEqual(transcript("## 9. uninstall")[0]);
    expect(existsSync(join(ctx.home, "machine.json"))).toBe(true);
    expect(ctx.service.remove).toHaveBeenCalledOnce();
  });

  it("9: a second run has nothing to remove; exit 0", async () => {
    const ctx = fakeCtx({
      service: launchd(false),
      which: ALL,
      exec: execWith(),
    });
    approve(ctx);
    expect(await uninstall({ purge: false }, ctx)).toBe(0);
    expect(ctx.all().slice(2, 4)).toEqual([
      "[[success]]✓[[/success]]  No service to remove",
      "[[success]]✓[[/success]]  No harness had the bus wired",
    ]);
  });

  it("9: only the OpenCode plugin folder was left: says so, never 'from OpenCode'", async () => {
    const ctx = fakeCtx({
      service: launchd(false),
      which: ALL,
      exec: execWith(),
    });
    approve(ctx);
    mkdirSync(join(ctx.home, "integrations/opencode/oa_bus"), {
      recursive: true,
    });
    expect(await uninstall({ purge: false }, ctx)).toBe(0);
    expect(ctx.all().slice(2, 5)).toEqual([
      "[[success]]✓[[/success]]  No service to remove",
      "[[success]]✓[[/success]]  Removed the OpenCode plugin folder",
      "[[success]]✓[[/success]]  Restarted the OpenCode service to unload the plugin",
    ]);
  });

  it("9: OpenCode's service not running", async () => {
    const ctx = fakeCtx({
      service: launchd(),
      which: ALL,
      exec: execWith("2.0.32", 1),
    });
    await installed(ctx);
    await uninstall({ purge: false }, ctx);
    expect(ctx.all()[4]).toBe(
      "[[success]]✓[[/success]]  OpenCode service not running; nothing to restart",
    );
  });

  it("10: --purge deletes ~/.oa-bus and names the machine to revoke; exit 0", async () => {
    const ctx = fakeCtx({
      service: launchd(),
      which: ALL,
      exec: execWith(),
      // machine.json's hub is the one to revoke on, whatever OA_BUS_INSTANCE says.
      env: { OA_BUS_INSTANCE: "https://other.example.org" },
    });
    await installed(ctx);
    expect(await uninstall({ purge: true }, ctx)).toBe(0);
    expect(ctx.all()).toEqual(transcript("## 10. uninstall --purge")[0]);
    expect(existsSync(ctx.home)).toBe(false);
  });

  it("10: --purge refuses an OA_BUS_HOME that is not the bus's (DRAFT copy)", async () => {
    const userHome = mkdtempSync(join(tmpdir(), "ob-cli-home-"));
    const ctx = fakeCtx({ userHome, home: join(userHome, "work") });
    mkdirSync(join(ctx.home, "logs"), { recursive: true });
    writeFileSync(join(ctx.home, "logs/daemon.log"), "theirs");
    expect(await uninstall({ purge: true }, ctx)).toBe(1);
    expect(ctx.all()).toEqual(transcript("## 10. uninstall --purge")[2]);
    expect(existsSync(join(ctx.home, "logs/daemon.log"))).toBe(true);
  });

  it("10: --purge keeps ~/.oa-bus while the daemon still answers; exit 1", async () => {
    const ctx = fakeCtx({
      service: launchd(),
      which: ALL,
      exec: execWith(),
      status: up(),
    });
    await installed(ctx);
    expect(await uninstall({ purge: true }, ctx)).toBe(1);
    expect(ctx.all()).toEqual(transcript("## 10. uninstall --purge")[1]);
    expect(existsSync(join(ctx.home, "machine.json"))).toBe(true);
  });
});

describe("--home", () => {
  it("uninstall --purge --home X purges X, not ~/.oa-bus", async () => {
    const ctx = fakeCtx();
    approve(ctx);
    const own = ctx.home;
    const other = join(ctx.userHome, "other");
    mkdirSync(other);
    writeFileSync(join(other, "machine.json"), "{}");
    expect(
      await main(["uninstall", "--purge", "--home", other], () => ctx),
    ).toBe(0);
    expect(existsSync(other)).toBe(false);
    expect(existsSync(join(own, "machine.json"))).toBe(true);
  });

  it("status --home X reads X", async () => {
    const ctx = fakeCtx();
    const other = join(ctx.userHome, "other");
    expect(await main(["status", "--home", other], () => ctx)).toBe(1);
    expect(ctx.home).toBe(other);
  });
});

describe("purge safety", () => {
  const shared = { isDefault: false };
  const own = { isDefault: true };

  it("never removes what Open Artifacts bus did not create, so a shared OA_BUS_HOME survives", () => {
    const home = mkdtempSync(join(tmpdir(), "ob-purge-"));
    writeFileSync(join(home, "machine.json"), "{}");
    writeFileSync(join(home, "notes.txt"), "mine");
    mkdirSync(join(home, "projects"));
    writeFileSync(join(home, "projects/a"), "mine");
    // A known file name that is someone's directory is left alone.
    mkdirSync(join(home, "sent.json"));
    writeFileSync(join(home, "sent.json/x"), "mine");
    const out = purge(home, shared);
    expect(out).toMatchObject({ leftDir: true });
    expect(readdirSync(home).sort()).toEqual([
      "notes.txt",
      "projects",
      "sent.json",
    ]);
  });

  it("keeps the user's own logs/ and config.json in a shared folder", () => {
    const home = mkdtempSync(join(tmpdir(), "ob-purge-"));
    mkdirSync(join(home, "logs"));
    writeFileSync(join(home, "logs/my-app.log"), "user data\n");
    writeFileSync(join(home, "logs/daemon.log"), "ours\n");
    mkdirSync(join(home, "integrations/opencode/oa_bus"), { recursive: true });
    writeFileSync(join(home, "integrations/opencode/oa_bus/tui.js"), "ours");
    mkdirSync(join(home, "integrations/other"));
    writeFileSync(join(home, "config.json"), '{"mine":true}\n');
    writeFileSync(join(home, "machine.json"), "{}\n");
    purge(home, shared);
    expect(existsSync(join(home, "machine.json"))).toBe(false);
    expect(existsSync(join(home, "logs/daemon.log"))).toBe(false);
    expect(existsSync(join(home, "logs/my-app.log"))).toBe(true);
    expect(existsSync(join(home, "config.json"))).toBe(true);
    expect(existsSync(join(home, "integrations/opencode"))).toBe(false);
    expect(existsSync(join(home, "integrations/other"))).toBe(true);
  });

  it("removes the bus's folders once they are empty, then the home", () => {
    const home = mkdtempSync(join(tmpdir(), "ob-purge-"));
    writeFileSync(join(home, "machine.json"), "{}");
    mkdirSync(join(home, "logs"));
    writeFileSync(join(home, "logs/daemon.log"), "x");
    mkdirSync(join(home, "integrations/opencode/oa_bus"), { recursive: true });
    mkdirSync(join(home, "opencode-tui"));
    writeFileSync(join(home, "opencode-tui/4321.json"), "{}");
    mkdirSync(join(home, "claude-return"));
    expect(purge(home, own)).toMatchObject({ leftDir: false });
    expect(existsSync(home)).toBe(false);
  });

  it("refuses a home that is not ~/.oa-bus and holds no machine.json or install.json", () => {
    const home = mkdtempSync(join(tmpdir(), "ob-purge-"));
    mkdirSync(join(home, "logs"));
    writeFileSync(join(home, "logs/daemon.log"), "maybe someone else's");
    expect(purge(home, shared)).toEqual({ refused: true });
    expect(existsSync(join(home, "logs/daemon.log"))).toBe(true);
  });

  it("leaves a symlinked folder and its target alone", () => {
    const home = mkdtempSync(join(tmpdir(), "ob-purge-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "ob-else-"));
    writeFileSync(join(elsewhere, "daemon.log"), "x");
    symlinkSync(elsewhere, join(home, "logs"));
    writeFileSync(join(home, "install.json"), "{}");
    expect(purge(home, own)).toMatchObject({ leftDir: true });
    expect(readdirSync(elsewhere)).toEqual(["daemon.log"]);
  });

  it("removes interrupted temp files and a missing home is fine", () => {
    const home = mkdtempSync(join(tmpdir(), "ob-purge-"));
    writeFileSync(join(home, ".machine.json.0a1b.tmp"), "");
    writeFileSync(join(home, "install.json.123.0a1b2c3d.tmp"), "");
    writeFileSync(join(home, "sent.json.123.tmp"), "");
    expect(purge(home, own)).toMatchObject({ leftDir: false });
    expect(purge(join(home, "gone"), own)).toEqual({
      removed: [],
      leftDir: false,
    });
  });
});

describe("logs, mcp, version", () => {
  it("logs prints the last 50 lines, or says there is none yet", async () => {
    const a = fakeCtx();
    expect(await logs(a)).toBe(1);
    expect(a.out()[0]).toBe(
      "[[warning]]![[/warning]]  No daemon log yet at ~/.oa-bus/logs/daemon.log",
    );
    const b = fakeCtx();
    mkdirSync(join(b.home, "logs"), { recursive: true });
    writeFileSync(
      join(b.home, "logs/daemon.log"),
      `${Array.from({ length: 60 }, (_, i) => `l${i}`).join("\n")}\n`,
    );
    expect(await logs(b)).toBe(0);
    expect(b.out()).toHaveLength(50);
    expect(b.out()[0]).toBe("l10");
  });

  it("mcp runs the adapter entry, and explains Pi", async () => {
    const load = vi.fn(async () => ({}));
    expect(await mcp("claude", fakeCtx(), load)).toBeUndefined();
    expect(await mcp("opencode", fakeCtx(), load)).toBeUndefined();
    expect(await mcp("codex", fakeCtx(), load)).toBeUndefined();
    expect(load.mock.calls).toEqual([["claude"], ["opencode"], ["codex"]]);
    const pi = fakeCtx();
    expect(await mcp("pi", pi, load)).toBe(1);
    expect(pi.out()[0]).toMatch(/Pi uses the bus extension/);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("main: version, and a usage error exits 2", async () => {
    const ctx = fakeCtx();
    expect(await main(["version"], () => ctx)).toBe(0);
    expect(await main(["-v"], () => ctx)).toBe(0);
    expect(ctx.out()).toEqual(["oa-bus 0.1.0", "oa-bus 0.1.0"]);
    const bad = fakeCtx();
    expect(await main(["wat"], () => bad)).toBe(2);
    expect(bad.err()[0]).toBe("[[danger]]×[[/danger]]  Unknown command: wat");
  });

  it("main passes --no-color to the context", async () => {
    const seen: boolean[] = [];
    await main(["version", "--no-color"], (n) => {
      seen.push(n);
      return fakeCtx();
    });
    expect(seen).toEqual([true]);
  });
});

describe("daemon command", () => {
  const fake = () => {
    const signals = new EventEmitter() as unknown as Parameters<
      typeof daemon
    >[2] &
      EventEmitter;
    const stop = vi.fn(async () => {});
    let deps: { onRevoked?: (replaced?: boolean) => void } = {};
    const run = vi.fn(
      async (d: { onRevoked?: (replaced?: boolean) => void }) => {
        deps = d;
        return { stop } as unknown as Awaited<
          ReturnType<Parameters<typeof daemon>[1] & {}>
        >;
      },
    );
    return {
      signals,
      stop,
      run,
      revoke: (replaced?: boolean) => deps.onRevoked?.(replaced),
    };
  };

  it("stays in the foreground and exits 0 on SIGTERM", async () => {
    const f = fake();
    const done = daemon(fakeCtx(), f.run as never, f.signals);
    await vi.waitFor(() => expect(f.run).toHaveBeenCalled());
    f.signals.emit("SIGTERM");
    expect(await done).toBe(0);
    expect(f.stop).toHaveBeenCalledOnce();
  });

  it("exits 78, once, when the machine is revoked", async () => {
    const f = fake();
    const done = daemon(fakeCtx(), f.run as never, f.signals);
    await vi.waitFor(() => expect(f.run).toHaveBeenCalled());
    f.revoke();
    f.revoke();
    f.signals.emit("SIGINT");
    expect(await done).toBe(78);
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.signals.listenerCount("SIGINT")).toBe(0);
  });

  it("exits 1 for a restart when only an older token was revoked", async () => {
    const f = fake();
    const done = daemon(fakeCtx(), f.run as never, f.signals);
    await vi.waitFor(() => expect(f.run).toHaveBeenCalled());
    f.revoke(true);
    expect(await done).toBe(1);
  });

  it("starts when the revoked marker names another token", async () => {
    const f = fake();
    const ctx = fakeCtx();
    approve(ctx);
    writeFileSync(join(ctx.home, "revoked"), revokedMarker(newMachineToken()));
    const done = daemon(ctx, f.run as never, f.signals);
    await vi.waitFor(() => expect(f.run).toHaveBeenCalled());
    f.signals.emit("SIGTERM");
    expect(await done).toBe(0);
  });

  it("exits 0 without starting when the revoked marker is there", async () => {
    const f = fake();
    const ctx = fakeCtx();
    mkdirSync(ctx.home, { recursive: true });
    writeFileSync(join(ctx.home, "revoked"), "");
    expect(await daemon(ctx, f.run as never, f.signals)).toBe(0);
    expect(f.run).not.toHaveBeenCalled();
    expect(ctx.err()).toEqual([
      "[[danger]]×[[/danger]]  This machine was revoked.",
      "   Run npx @open-artifacts/bus install to approve it again.",
    ]);
  });

  describe("under a service (OA_BUS_SERVICE=1)", () => {
    const start = (env: Record<string, string>, error: Error) => {
      const ctx = fakeCtx({ env });
      return daemon(
        ctx,
        async () => {
          throw error;
        },
        new EventEmitter() as never,
      ).then((code) => ({ code, err: ctx.err() }));
    };
    const lastingErrors = [
      new StartError(
        "NOT_LOGGED_IN",
        "not logged in: run `npx @open-artifacts/bus install`",
      ),
      new StartError(
        "SOCKET_IN_USE",
        "daemon already listening on /x/daemon.sock",
      ),
      new StartError(
        "HUB_MISMATCH",
        "the hub https://a is not the one this machine was approved for (https://b)",
      ),
    ];

    it("a lasting start failure logs one line and exits 0, so no manager restarts it", async () => {
      for (const e of lastingErrors) {
        const r = await start({ OA_BUS_SERVICE: "1" }, e);
        expect(r.code).toBe(0);
        // The copy's failure block, the message clipped to 80 columns.
        expect(r.err).toEqual(fakeCtx().copy.failed(e.message));
      }
    });

    it("a transient failure still exits 1, to be restarted", async () => {
      const r = await start({ OA_BUS_SERVICE: "1" }, new Error("ECONNRESET"));
      expect(r.code).toBe(1);
    });

    it("a machine.json it may not read (EACCES, EPERM) is lasting too", async () => {
      for (const code of ["EACCES", "EPERM"]) {
        const e = Object.assign(new Error(`${code}: open machine.json`), {
          code,
        });
        expect((await start({ OA_BUS_SERVICE: "1" }, e)).code).toBe(0);
      }
    });

    it("matches the code, never the message", async () => {
      const r = await start(
        { OA_BUS_SERVICE: "1" },
        new Error("not logged in: run `npx @open-artifacts/bus install`"),
      );
      expect(r.code).toBe(1);
    });

    it("in a terminal the same failures exit 1", async () => {
      for (const e of lastingErrors) expect((await start({}, e)).code).toBe(1);
    });
  });

  it("exits 1 with the reason when it cannot start", async () => {
    const ctx: Ctx = fakeCtx();
    const code = await daemon(
      ctx,
      async () => {
        throw new Error("not logged in: run `npx @open-artifacts/bus install`");
      },
      new EventEmitter() as never,
    );
    expect(code).toBe(1);
    expect((ctx as Fake).err()[0]).toBe(
      "[[danger]]×[[/danger]]  not logged in: run `npx @open-artifacts/bus install`",
    );
  });
});
