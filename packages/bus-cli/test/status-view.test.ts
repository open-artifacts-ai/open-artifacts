// `oa-bus status` (and install's closing table) with status. Roles are gone.
import { describe, expect, it } from "vitest";
import { rosterBlock, rosters } from "../src/commands/install.ts";
import { cols, cutCols } from "../src/copy.ts";
import type { Style } from "../src/term.ts";
import { fakeCtx } from "./fake.ts";

const NONE: Style = { color: "none", dark: true, utf8: true };
const ctx = () => fakeCtx({ style: NONE });
const ago = (c: ReturnType<typeof ctx>, m: number) =>
  new Date(c.clock.t - m * 60_000).toISOString();
const width = cols;

const row = (r: Record<string, unknown>) => ({
  name: "code-96",
  kind: "claude-code",
  machine: "mbp",
  state: "live" as const,
  ...r,
});

describe("status roster with status", () => {
  it("a role from the daemon adds no column", () => {
    const c = ctx();
    const { lines } = rosterBlock(c, {
      namespace: "ns",
      agents: [row({ role: "lane-6" }), row({ name: "b" })],
    });
    expect(lines.slice(1)).toEqual([
      "  b                   Claude Code  mbp                   ● live",
      "  code-96             Claude Code  mbp                   ● live",
    ]);
  });

  it("a status with and without a label, and a stale one, on the line under the row", () => {
    const c = ctx();
    const { lines } = rosterBlock(c, {
      namespace: "ns",
      agents: [
        row({
          name: "a",
          status: "working",
          status_label: "writing tests",
          status_at: ago(c, 1),
        }),
        row({ name: "b", status: "idle", status_at: ago(c, 0) }),
        row({ name: "c", status: "blocked", status_at: ago(c, 120) }),
      ],
    });
    expect(lines.slice(1)).toEqual([
      "  a                   Claude Code  mbp                   ● live",
      '    agent says: working · "writing tests"',
      "  b                   Claude Code  mbp                   ● live",
      "    agent says: idle",
      "  c                   Claude Code  mbp                   ● live",
      "    agent says: blocked · 2 h ago",
    ]);
  });

  it("a hostile or long label: stripped, cut, within 80 columns", () => {
    const c = ctx();
    const { lines } = rosterBlock(c, {
      namespace: "ns",
      agents: [
        row({
          status: "working\x1b[2J",
          status_label: `\x1b[31m${"y".repeat(64)}​`,
          status_at: ago(c, 60 * 24 * 3),
        }),
      ],
    });
    const out = lines.join("\n");
    for (const ch of ["\x1b", "\x07", "‮", "​"]) expect(out).not.toContain(ch);
    for (const l of lines) expect(width(l)).toBeLessThanOrEqual(80);
    expect(lines[1]).toMatch(/^ {2}code-96 /);
    expect(lines[2]).toMatch(/^ {4}agent says: working · "y+…$/);
  });

  it("with no status set, no status lines", () => {
    const c = ctx();
    const plain = [row({}), row({ name: "b", state: "queued" })];
    expect(rosters(c, [{ namespace: "ns", agents: plain }])).toEqual([
      "2 agents in namespace ns  1 live · 1 queued",
      "  code-96             Claude Code  mbp                   ● live",
      "  b                   Claude Code  mbp                   ○ queued",
      "Mail to a queued agent waits up to 1 hour for its machine to reconnect;",
      "then the sender is told.",
    ]);
  });
});

describe("CLI cuts by columns, not code points", () => {
  it("counts wide CJK and emoji as 2, marks and joiners as 0", () => {
    expect(cols("abc")).toBe(3);
    expect(cols("書いている")).toBe(10);
    expect(cols("😀")).toBe(2);
    expect(cols("👩\u200d💻")).toBe(2);
    expect(cols("e\u0301")).toBe(1);
    expect(cols("❤\ufe0f")).toBe(2);
    expect(cols("ｔｅｓｔ")).toBe(8);
  });

  it("cuts on a grapheme boundary within the columns", () => {
    expect(cutCols("書".repeat(10), 7)).toBe("書書書…");
    expect(cutCols("👩\u200d💻".repeat(5), 6)).toBe("👩\u200d💻👩\u200d💻…");
    expect(cutCols("short", 10)).toBe("short");
  });

  it.each([
    ["CJK", "書".repeat(64)],
    ["emoji", "😀".repeat(64)],
    ["ZWJ emoji", "👩\u200d💻".repeat(30)],
    ["mixed", `tests ${"テスト".repeat(20)} 🚀`],
  ])(
    "a %s label, name and machine keep every line within 80 columns",
    (_, wide) => {
      const c = ctx();
      const { lines } = rosterBlock(c, {
        namespace: "ns",
        agents: [
          row({
            name: wide.slice(0, 30),
            machine: wide,
            status: "working",
            status_label: wide,
            status_at: ago(c, 1),
          }),
        ],
      });
      for (const l of lines) expect(cols(l)).toBeLessThanOrEqual(80);
      expect(lines[2]).toMatch(/^ {4}agent says: working · "/);
      expect(lines[2]?.endsWith("…")).toBe(true);
      // The columns still line up: the state starts where a plain row's does.
      expect(cols(lines[1]?.slice(0, lines[1].indexOf("●")) ?? "")).toBe(57);
    },
  );
});
