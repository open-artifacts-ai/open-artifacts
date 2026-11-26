import { describe, expect, it } from "vitest";
import { isTest, scanText, stripComments } from "./no-test-sleeps.ts";

const found = (text: string) => scanText(text).map((h) => h.why);
const lines = (text: string) => scanText(text).map((h) => h.line);

describe("no-test-sleeps: what it finds", () => {
  it("a setTimeout promise, on one line or in a generic", () => {
    expect(found("await new Promise((r) => setTimeout(r, 50));")).toEqual([
      "setTimeout promise",
    ]);
    expect(
      found("await new Promise<void>((resolve) => setTimeout(resolve, 1));"),
    ).toEqual(["setTimeout promise"]);
  });

  it("a brace body, and a Promise whose executor spans lines (#3091)", () => {
    expect(found("await new Promise((r) => { setTimeout(r, 5); });")).toEqual([
      "setTimeout promise",
    ]);
    const multi = [
      "const done = new Promise<void>(",
      "  (resolve, reject) => {",
      "    const t = setTimeout(() => reject(new Error('no')), 15_000);",
      "    ws.once('close', () => { clearTimeout(t); resolve(); });",
      "  },",
      ");",
    ].join("\n");
    expect(found(multi)).toEqual(["setTimeout promise"]);
    expect(lines(multi)).toEqual([1]);
  });

  it("promisify(setTimeout)", () => {
    expect(found("const wait = promisify(setTimeout);")).toEqual([
      "setTimeout promise",
    ]);
  });

  it("node:timers/promises: setTimeout, setInterval, scheduler, a namespace, require", () => {
    expect(
      found('import { setTimeout as sleepFor } from "node:timers/promises";'),
    ).toEqual(["timers/promises"]);
    expect(found('import { setTimeout } from "timers/promises";')).toEqual([
      "timers/promises",
    ]);
    expect(
      found('import { scheduler, setImmediate } from "node:timers/promises";'),
    ).toEqual(["timers/promises"]);
    expect(found('import * as t from "node:timers/promises";')).toEqual([
      "timers/promises",
    ]);
    expect(
      found('const { setTimeout } = require("node:timers/promises");'),
    ).toEqual(["timers/promises"]);
    expect(found("await scheduler.wait(100);")).toEqual(["timers/promises"]);
  });

  it("a sleep helper or call", () => {
    expect(
      found(
        [
          "await sleep(10);",
          "const sleep = (ms: number) => new Promise((r) => r(ms));",
          "function sleepFor(ms) { return null; }",
        ].join("\n"),
      ),
    ).toEqual(["sleep", "sleep", "sleep"]);
  });

  it("Playwright's waitForTimeout", () => {
    expect(found("await page.waitForTimeout(200);")).toEqual([
      "waitForTimeout",
    ]);
  });

  it("toPass and expect.poll given intervals", () => {
    expect(
      found(
        "await expect(async () => { await a(); }).toPass({ intervals: [100, 250] });",
      ),
    ).toEqual(["poll intervals"]);
    expect(
      found(
        [
          "await expect",
          "  .poll(() => read(), { intervals: [50], timeout: 5_000 })",
          "  .toBe(1);",
        ].join("\n"),
      ),
    ).toEqual(["poll intervals"]);
    expect(
      found(
        "await expect.poll(() => read(), { intervals: [50], timeout: 5_000 }).toBe(1);",
      ),
    ).toEqual(["poll intervals"]);
    expect(
      found("await expect.poll(() => read(), { interval: 50 }).toBe(1);"),
    ).toEqual(["poll intervals"]);
  });

  it("a shell sleep in a fixture, and a sleep child process", () => {
    expect(found('exec("sleep 30");')).toEqual(["shell sleep"]);
    expect(found("sleep 0.5\ncurl -s localhost")).toEqual(["shell sleep"]);
    expect(found('spawn("sleep", ["30"]);')).toEqual(["shell sleep"]);
    expect(found('my $c = fork(); exec("sleep", "60");')).toEqual([
      "shell sleep",
    ]);
    expect(
      found("const script = `#!/bin/sh\necho up\nsleep 2\necho done\n`;"),
    ).toEqual(["shell sleep"]);
  });

  it("reports the line of the wait, not of the statement start", () => {
    expect(
      lines(["const a = 1;", "", "await page.waitForTimeout(5);"].join("\n")),
    ).toEqual([3]);
  });

  it("no longer honours a sleep-ok mark", () => {
    expect(
      found(
        [
          "await sleep(5); // sleep-ok: the daemon has no ready event yet",
          "// sleep-ok: the socket close has no other signal",
          "await sleep(5);",
        ].join("\n"),
      ),
    ).toEqual(["sleep", "sleep"]);
  });
});

describe("no-test-sleeps: what it leaves alone", () => {
  it("a signal wait, a fake clock and a yield", () => {
    expect(
      found(
        [
          "await waitFor(() => expect(x).toBe(1));",
          "vi.useFakeTimers({ toFake: ['Date'] });",
          "await vi.advanceTimersByTimeAsync(1000);",
          "vi.advanceTimersByTime(10);",
          "await new Promise((r) => setImmediate(r));",
          "await new Promise<void>((r) => ws.once('open', () => r()));",
          "await new Promise((resolve) => { server.listen(0, resolve); });",
          'import { setImmediate } from "node:timers/promises";',
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("a timer that is not inside a Promise executor", () => {
    expect(
      found(
        [
          "setTimeout(() => ws.close(), 0);",
          "const t = setTimeout(fn, 10);",
          "clearTimeout(t);",
          "await expect(async () => { await a(); }).toPass();",
          "await expect.poll(() => read()).toBe(1);",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("a comment, a name that only looks like a sleep, and prose", () => {
    expect(
      found(
        [
          "// never await new Promise((r) => setTimeout(r, 1));",
          "/* await sleep(5); */",
          "/**",
          " * await page.waitForTimeout(1);",
          " */",
          "const sleepers = 3; // agents that sleep",
          'const title = "the agent sleeps for a while";',
          "const sleeping = true;",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("a Promise after a commented-out one", () => {
    expect(
      found(
        [
          "/* await new Promise((r) => {",
          "  setTimeout(r, 5);",
          "}); */",
          "await new Promise((r) => ws.once('x', r));",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});

describe("no-test-sleeps: stripComments and the file filter", () => {
  it("blanks comments, keeps line count and strings", () => {
    const src =
      'const a = "// not a comment"; // gone\n/* x\ny */ const b = 1;';
    const out = stripComments(src);
    expect(out.split("\n")).toHaveLength(src.split("\n").length);
    expect(out).toContain('"// not a comment"');
    expect(out).not.toContain("gone");
    expect(out).toContain("const b = 1;");
  });

  it("knows which files are tests: ts, tsx, mjs, js, sh and the folders", () => {
    for (const p of [
      "apps/dashboard/test/a.tsx",
      "apps/dashboard/e2e/a.spec.ts",
      "apps/dashboard/e2e/doc-room.mjs",
      "packages/shared/test/a.test.ts",
      "packages/x/test/fixtures/run.sh",
      "tests/a.js",
      "apps/server/test/bus/helpers.ts",
      "packages/x/src/a.test.mjs",
    ])
      expect(isTest(p), p).toBe(true);
    for (const p of [
      "apps/dashboard/src/a.tsx",
      "packages/x/src/index.ts",
      "scripts/ci/release.sh",
      "apps/dashboard/test/readme.md",
    ])
      expect(isTest(p), p).toBe(false);
  });
});
