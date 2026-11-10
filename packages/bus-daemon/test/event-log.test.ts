import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_REFUSALS,
  createEventLog,
  formatEvent,
  refusalKey,
} from "../src/index.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "oa-evlog-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const at = new Date("2026-11-11T10:00:00.000Z");

describe("formatEvent", () => {
  it("is one line: time, event, fields", () => {
    expect(
      formatEvent(at, "agent_join", { kind: "codex", name: "a b", pid: 7 }),
    ).toBe('2026-11-11T10:00:00.000Z agent_join kind=codex name="a b" pid=7');
  });
  it("never writes a body, a token or a hash, nor a newline", () => {
    const line = formatEvent(at, "x", {
      body: "secret text",
      token: "tok",
      proof: "p",
      hash: "h",
      reason: "a\nb",
    });
    expect(line).not.toMatch(/secret|tok|proof|hash/);
    expect(line).toBe('2026-11-11T10:00:00.000Z x reason="a b"');
    expect(line).not.toContain("\n");
  });
  it("truncates long values", () => {
    expect(formatEvent(at, "x", { name: "n".repeat(500) }).length).toBeLessThan(
      200,
    );
  });
});

describe("refusalKey", () => {
  it("names the CODEX_REFUSALS key, else other", () => {
    expect(refusalKey(CODEX_REFUSALS.subagent)).toBe("subagent");
    expect(refusalKey("anything else")).toBe("other");
  });
});

describe("createEventLog", () => {
  it("appends lines, creating the folder", async () => {
    const f = join(tmp(), "logs", "daemon.log");
    const log = createEventLog(f, { now: () => at });
    log("daemon_start", { version: "1.2.3", pid: 1 });
    log("hub_connect");
    await log.flush();
    expect(readFileSync(f, "utf8").split("\n")).toEqual([
      "2026-11-11T10:00:00.000Z daemon_start version=1.2.3 pid=1",
      "2026-11-11T10:00:00.000Z hub_connect",
      "",
    ]);
  });
  it("rotates to .1 past the limit and keeps one old file", async () => {
    const f = join(tmp(), "daemon.log");
    const log = createEventLog(f, { maxBytes: 200, now: () => at });
    for (let i = 0; i < 20; i++) log("e", { id: String(i) });
    await log.flush();
    expect(existsSync(`${f}.1`)).toBe(true);
    expect(existsSync(`${f}.2`)).toBe(false);
    expect(readFileSync(f, "utf8").length).toBeLessThanOrEqual(200);
    expect(readFileSync(f, "utf8")).toContain("id=19");
  });
  it("starts from the file's existing size", async () => {
    const f = join(tmp(), "daemon.log");
    writeFileSync(f, "x".repeat(190));
    const log = createEventLog(f, { maxBytes: 200, now: () => at });
    log("e");
    await log.flush();
    expect(readFileSync(`${f}.1`, "utf8")).toBe("x".repeat(190));
  });
  it("swallows an fs error and never throws", async () => {
    const d = tmp();
    writeFileSync(join(d, "file"), "");
    const log = createEventLog(join(d, "file", "sub", "daemon.log"));
    expect(() => log("e")).not.toThrow();
    await expect(log.flush()).resolves.toBeUndefined();
  });
});
