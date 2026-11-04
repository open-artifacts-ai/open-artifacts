import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ago, copy, cutMiddle, tokenTail } from "../src/copy.ts";
import { main } from "../src/main.ts";
import { detectStyle, paint, type Style } from "../src/term.ts";
import { fakeCtx, TAGS, transcript } from "./fake.ts";

const NONE: Style = { color: "none", dark: true, utf8: true };
const c = copy(TAGS);
const plain = copy(NONE);

describe("transcript parity: the service lines", () => {
  const md = readFileSync(
    new URL("../design/transcript.md", import.meta.url),
    "utf8",
  );
  /** Backticked in the prose, verbatim; a next line with or without its indent. */
  const quotedIn = (line: string) =>
    md.includes(`\`${line}\``) ||
    md.includes(`\`${line.replace(/^ {3}/, "")}\``);

  it.each([
    ["the service manager cannot run it", c.daemonRunning(1, undefined, true)],
    ["install can still fix it", c.daemonRunning(1)],
    ["uninstall stops a daemon", [c.daemonStopped()]],
    ["doctor: a gone Node", c.serviceNodeMissing("/usr/local/bin/node")],
    ["doctor: lingering off", c.lingerOff()],
    [
      "install: a daemon that will not stop",
      c.daemonInTheWay("~/.oa-bus/daemon.sock", 48213),
    ],
    ["uninstall: a daemon still running", c.daemonStillRunning(48213)],
  ])("%s", (_name, lines) => {
    for (const l of lines) expect(quotedIn(l), l).toBe(true);
  });

  it("a long socket path is cut in the middle, the line within 80", () => {
    const [line] = plain.daemonInTheWay(
      `/${"s".repeat(120)}/daemon.sock`,
      4194304,
    );
    expect(line).toMatch(
      /^× {2}Another daemon is still running \(pid 4194304\) on \/s+…\/daemon\.sock\.$/,
    );
    expect([...(line as string)].length).toBe(80);
  });

  it("a long Node path is cut in the middle, the line within 80", () => {
    const [line] = plain.serviceNodeMissing(`/${"n".repeat(120)}/bin/node`);
    expect(line).toMatch(
      /^× {2}The service runs a Node that is gone: \/n+…\/node\.$/,
    );
    expect([...(line as string)].length).toBeLessThanOrEqual(80);
  });
});

describe("transcript parity: usage errors", () => {
  it("a mistyped command prints the parser's message, then the command list", async () => {
    const ctx = fakeCtx();
    expect(await main(["instal"], () => ctx)).toBe(2);
    expect(ctx.err()).toEqual(transcript("## Usage errors")[0]);
  });
});

describe("transcript parity: the roster", () => {
  const block = transcript("## 1. First run, browser opens")[1] as string[];
  const rows = block.filter((l) => l.startsWith("  oa-bus-"));
  const machine = (l: string) => l.slice(35, 57).trim();

  it("renders each row of the transcript's table", () => {
    for (const row of rows) {
      const [name, kind] = [row.slice(2, 22).trim(), row.slice(22, 35).trim()];
      const kinds: Record<string, string> = {
        "Claude Code": "claude-code",
        OpenCode: "opencode",
        Pi: "pi",
      };
      expect(
        c.rosterRow({
          name,
          kind: kinds[kind] as string,
          machine: machine(row),
          state: row.includes("queued") ? "queued" : "live",
        }),
      ).toBe(row);
    }
    expect(rows).toHaveLength(5);
  });

  it("renders the header, the queued footnote and the more line", () => {
    expect(c.rosterHeader("github.com/open-artifacts-ai/oa-bus", 4, 1)).toBe(
      block.find((l) => l.startsWith("5 agents")),
    );
    const i = block.findIndex((l) => l.includes("Mail to a queued agent"));
    expect(c.queuedFootnote()).toEqual(block.slice(i, i + 2));
    expect(c.rosterMore(7)).toBe(
      "  [[muted]]and 7 more · npx @open-artifacts/bus status[[/muted]]",
    );
    expect(c.rosterHeader("ns", 1, 0)).toMatch(/^1 agent in namespace/);
  });

  it("cuts a long cell to its width minus 2 plus …, keeping a space", () => {
    const row = plain.rosterRow({
      name: "n".repeat(30),
      kind: "claude-code",
      machine: "m".repeat(40),
      state: "live",
    });
    expect(row).toBe(
      `  ${"n".repeat(18)}… Claude Code  ${"m".repeat(20)}… ● live`,
    );
    expect([...row].length).toBe(63);
    const queued = plain.rosterRow({
      name: "n",
      kind: "pi",
      machine: "m".repeat(40),
      state: "queued",
    });
    // The widest row is 65 columns.
    expect([...queued].length).toBe(65);
  });
});

describe("the codex kind (C26a)", () => {
  it("shows as Codex in the roster", () => {
    expect(
      plain.rosterRow({
        name: "n",
        kind: "codex",
        machine: "m",
        state: "live",
      }),
    ).toContain("Codex");
  });
});

describe("an unknown kind (C26h)", () => {
  it("shows as its own token in the roster", () => {
    expect(
      plain.rosterRow({ name: "n", kind: "zz", machine: "m", state: "live" }),
    ).toMatch(/^ {2}n {19}zz {11}m /);
  });

  it("a hostile kind is stripped of controls and cut to the column", () => {
    const row = plain.rosterRow({
      name: "n",
      kind: `zz\x1b]52;c;aGk=\x07\x1b[8m${"y".repeat(20)}`,
      machine: "m",
      state: "live",
    });
    expect(row).not.toContain("\x1b");
    expect(row).toContain(`zz${"y".repeat(9)}…`);
  });
});

describe("cutting long values", () => {
  it("cuts the middle, keeping the end, to the transcript's example", () => {
    const ns = `github.com/very-long-org${"x".repeat(95)}/oa-bus`;
    expect(ns).toHaveLength(128);
    const line = plain.rosterHeader(ns, 4, 1);
    expect([...line].length).toBeLessThanOrEqual(80);
    expect(line).toMatch(
      /^5 agents in namespace github\.com\/very-long-orgx*…\/oa-bus {2}4 live · 1 queued$/,
    );
    expect(cutMiddle("abcdefghij", 5)).toBe("ab…ij");
  });

  it("keeps every line within 80 columns for 128-character values", () => {
    const long = "L".repeat(128);
    const host = `${"h".repeat(120)}.example.com`;
    const path = `/${long}`;
    const lines = [
      plain.approved(long),
      plain.alreadyConnected(long),
      plain.rosterHeader(long, 9, 9),
      ...plain.noAgents(long),
      ...plain.unreachable(host, 4, 3, 4),
      ...plain.unreachableFinal(host, 4, "ECONNREFUSED"),
      plain.hubRow(host),
      plain.machineRow(long),
      ...plain.hubNotReachable(host, "ECONNREFUSED", "status"),
      plain.hubReachable(host),
      ...plain.nodeOld(long),
      plain.credentials(path, `oa_machine_${"a".repeat(32)}`),
      ...plain.noCredentials(path),
      plain.wired("opencode", long),
      ...plain.claudeIsolates(path),
      ...plain.opencodeTooOld(long, "2.0.0"),
      ...plain.kept(path),
      plain.deleted(path),
      ...plain.stillListed(long, host),
      ...plain.skipped("opencode", long),
      ...plain.couldNotRemove("claude", long),
      ...plain.purgeLeftDir(path),
      ...plain.purgeDaemonRunning(path),
      ...plain.purgeRefused(path),
      ...plain.hubMismatch(host, host, `https://${host}`),
      ...plain.hubMismatch("bus.example.com", host, `https://${host}`),
      ...plain.noLog(path),
      ...plain.daemonRunning(99999999, undefined, true),
      ...plain.serviceNodeMissing(path),
      ...plain.lingerOff(),
      plain.daemonStopped(),
      ...plain.daemonInTheWay(path, 99999999),
      ...plain.daemonStillRunning(99999999),
      ...plain.failed(long),
    ];
    for (const l of lines) expect([...l].length, l).toBeLessThanOrEqual(80);
  });

  it("never shows more of a token than its prefix and 4 characters", () => {
    expect(tokenTail(`oa_machine_${"a".repeat(28)}7f3a`)).toBe(
      "oa_machine_…7f3a",
    );
  });
});

describe("doctor's summary line", () => {
  it("omits zero counts and pluralises warnings", () => {
    expect(plain.summary(0, 0, 8)).toBe("All 8 checks passed.");
    expect(plain.summary(3, 1, 3)).toBe("3 failed, 1 warning, 3 passed.");
    expect(plain.summary(0, 2, 5)).toBe("2 warnings, 5 passed.");
    expect(plain.summary(1, 0, 0)).toBe("1 failed.");
    expect(c.summary(0, 0, 1)).toBe("[[muted]]All 1 checks passed.[[/muted]]");
  });
});

describe("terminal style (PALETTE.md)", () => {
  const tty = { isTTY: true, hasColors: (d?: number) => (d ?? 16) <= 256 };
  it("NO_COLOR and --no-color turn colour off; glyphs stay", () => {
    expect(detectStyle({ NO_COLOR: "1" }, tty).color).toBe("none");
    expect(detectStyle({}, tty, true).color).toBe("none");
    expect(detectStyle({ FORCE_COLOR: "3" }, tty, true).color).toBe("none");
  });
  it("FORCE_COLOR: 0 off, 3 truecolor, anything else ANSI 16", () => {
    expect(detectStyle({ FORCE_COLOR: "0" }, tty).color).toBe("none");
    expect(detectStyle({ FORCE_COLOR: "3" }, {}).color).toBe("truecolor");
    expect(detectStyle({ FORCE_COLOR: "2" }, {}).color).toBe("ansi");
  });
  it("otherwise only a colour TTY, truecolor when it says so; TERM=dumb is off", () => {
    expect(detectStyle({}, {}).color).toBe("none");
    expect(detectStyle({}, tty).color).toBe("ansi");
    expect(detectStyle({ COLORTERM: "truecolor" }, tty).color).toBe(
      "truecolor",
    );
    expect(detectStyle({ TERM: "dumb" }, tty).color).toBe("none");
  });
  it("COLORFGBG picks light for a 7 or 15 background, else dark", () => {
    expect(detectStyle({ COLORFGBG: "0;15" }, {}).dark).toBe(false);
    expect(detectStyle({ COLORFGBG: "15;0" }, {}).dark).toBe(true);
    expect(detectStyle({}, {}).dark).toBe(true);
  });
  it("UTF-8 glyphs only for a UTF-8 locale; ASCII otherwise", () => {
    expect(detectStyle({ LANG: "en_US.UTF-8" }, {}).utf8).toBe(true);
    const ascii = copy({ color: "none", dark: true, utf8: false });
    expect(ascii.approved("x")).toBe("+  Approved as x");
    expect(ascii.codeBox("K3M7-QW29")[0]).toBe("   +-------------+");
    expect(ascii.waitingPlain()).toBe(
      "Waiting for approval (up to 10 minutes)...",
    );
  });
  it("paints from the CLI palette: truecolor, ANSI slots, never a background", () => {
    expect(
      paint({ color: "truecolor", dark: true, utf8: true }, "danger", "x"),
    ).toBe("\x1b[38;2;255;127;107mx\x1b[39m");
    expect(
      paint({ color: "ansi", dark: true, utf8: true }, "danger", "x"),
    ).toBe("\x1b[91mx\x1b[39m");
    expect(
      paint({ color: "ansi", dark: false, utf8: true }, "success", "x"),
    ).toBe("\x1b[32mx\x1b[39m");
    expect(
      paint({ color: "ansi", dark: true, utf8: true }, "hairline", "x"),
    ).toBe("x");
  });
});

describe("ago: Design's relative time (C17)", () => {
  const at = 1_000_000_000;
  const t = (ms: number) => ago(at, at + ms);
  it("now under 60 s, then whole minutes, then whole hours (floor)", () => {
    expect(t(0)).toBe("now");
    expect(t(59_999)).toBe("now");
    expect(t(59_000)).toBe("now");
    expect(t(60_000)).toBe("1 min ago");
    expect(t(119_999)).toBe("1 min ago");
    expect(t(59 * 60_000)).toBe("59 min ago");
    expect(t(60 * 60_000 - 1)).toBe("59 min ago");
    expect(t(60 * 60_000)).toBe("1 h ago");
    expect(t(119 * 60_000)).toBe("1 h ago");
    expect(t(120 * 60_000)).toBe("2 h ago");
  });
});

describe("the npm name: every printed command says npx @open-artifacts/bus (C18)", () => {
  const root = new URL("../../", import.meta.url);
  const md = readFileSync(new URL("bus-cli/design/transcript.md", root), "utf8");

  it("no rendered transcript line is wider than 80 columns", () => {
    let inFence = false;
    for (const l of md.split("\n")) {
      if (l.startsWith("```")) inFence = !inFence;
      else if (inFence) {
        const shown = l.replace(/\[\[\/?[a-z]+\]\]/g, "");
        expect([...shown].length, shown).toBeLessThanOrEqual(80);
      }
    }
  });

  it("the long next lines fit in 80 columns", () => {
    for (const again of ["status", "doctor"]) {
      for (const l of plain.hubNotReachable(
        "bus.example.com",
        undefined,
        again,
      ))
        expect([...l].length, l).toBeLessThanOrEqual(80);
    }
  });

  it("no copy string in scope says `npx oa-bus` or a bare `oa-bus <cmd>` to run", () => {
    const files = [
      "bus-cli/design/transcript.md",
      "bus-cli/src/copy.ts",
      "bus-cli/src/index.ts",
      "bus-cli/src/commands/install.ts",
      "bus-daemon/src/config.ts",
      "bus-daemon/src/index.ts",
      "bus-ipc/src/copy.ts",
      "bus-adapter-pi/assets/oa-bus.ts",
      "bus-adapter-claude-code/src/main.ts",
    ];
    for (const f of files) {
      const text = readFileSync(new URL(f, root), "utf8");
      expect(text, f).not.toMatch(/npx oa-bus/);
      expect(text, f).not.toMatch(/(run|Run) `?oa-bus /);
    }
  });
});
