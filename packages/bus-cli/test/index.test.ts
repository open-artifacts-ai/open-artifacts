import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencodeVersion } from "@oa/bus-adapter-opencode";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeExec } from "../src/deps.ts";
import { parse } from "../src/index.ts";

describe("cli", () => {
  it("install --no-service", () => {
    expect(parse(["install", "--no-service"])).toMatchObject({
      cmd: "install",
      alongside: false,
      noService: true,
    });
    expect(parse(["install"])).toMatchObject({ noService: false });
    expect(() => parse(["login", "--no-service"])).toThrow(/does not apply/);
  });

  it("parses install --alongside", () => {
    expect(parse(["install", "--alongside", "--home", "/x"])).toMatchObject({
      cmd: "install",
      alongside: true,
      home: "/x",
    });
  });

  it("defaults to install", () => {
    expect(parse([])).toEqual({
      cmd: "install",
      alongside: false,
      hub: undefined,
      yes: false,
      check: false,
      noOpen: false,
      noService: false,
      noColor: false,
    });
    expect(parse(["--instance", "https://h", "--no-open"])).toMatchObject({
      cmd: "install",
      hub: "https://h",
      noOpen: true,
    });
  });
  it("routes every command and flag", () => {
    expect(
      parse(["install", "--check", "-y", "--no-open", "--no-color"]),
    ).toEqual({
      cmd: "install",
      hub: undefined,
      noService: false,
      alongside: false,
      yes: true,
      check: true,
      noOpen: true,
      noColor: true,
    });
    expect(parse(["global", "add", "~/code/ops"])).toEqual({
      cmd: "global",
      sub: "add",
      dir: "~/code/ops",
      noColor: false,
    });
    expect(parse(["global", "list"])).toEqual({
      cmd: "global",
      sub: "list",
      noColor: false,
    });
    expect(() => parse(["global", "add"])).toThrow(/usage/);
    expect(() => parse(["global", "list", "x"])).toThrow(/unexpected/);
    expect(parse(["login", "--no-open", "--instance", "https://h"])).toEqual({
      cmd: "login",
      hub: "https://h",
      noOpen: true,
      noColor: false,
    });
    expect(
      parse(["daemon", "--instance", "https://h", "--home", "/x"]),
    ).toEqual({
      cmd: "daemon",
      hub: "https://h",
      home: "/x",
      noColor: false,
    });
    for (const h of ["claude", "opencode", "codex", "pi", "antigravity"])
      expect(parse(["mcp", h])).toEqual({
        cmd: "mcp",
        harness: h,
        noColor: false,
      });
    for (const cmd of ["status", "logs", "doctor", "version"])
      expect(parse([cmd, "--no-color"])).toEqual({ cmd, noColor: true });
    expect(parse(["uninstall"])).toEqual({
      cmd: "uninstall",
      purge: false,
      noColor: false,
    });
    expect(parse(["uninstall", "--purge"])).toMatchObject({ purge: true });
    expect(parse(["--version"])).toEqual({ cmd: "version", noColor: false });
    expect(parse(["status", "-v"])).toMatchObject({ cmd: "version" });
  });
  it("finds the subcommand after global flags", () => {
    expect(parse(["--no-color", "status"])).toEqual({
      cmd: "status",
      noColor: true,
    });
    // Never install: a flag uninstall does not take is refused.
    expect(() =>
      parse(["--instance", "https://h.example", "uninstall"]),
    ).toThrow(/--instance does not apply to oa-bus uninstall/);
    expect(parse(["--instance", "https://h", "login"])).toMatchObject({
      cmd: "login",
      hub: "https://h",
    });
    expect(parse(["--no-color", "mcp", "pi"])).toMatchObject({
      cmd: "mcp",
      harness: "pi",
    });
  });
  it("refuses a flag the command does not take", () => {
    expect(parse(["uninstall", "--purge", "--home", "/tmp/x"])).toMatchObject({
      cmd: "uninstall",
      purge: true,
      home: "/tmp/x",
    });
    expect(parse(["--home", "/x", "status"])).toMatchObject({
      cmd: "status",
      home: "/x",
    });
    expect(() => parse(["uninstall", "--instance", "https://h"])).toThrow(
      /--instance does not apply to oa-bus uninstall/,
    );
    expect(() => parse(["status", "--purge"])).toThrow(
      /--purge does not apply to oa-bus status/,
    );
    expect(() => parse(["--instance", "https://h", "doctor"])).toThrow(
      /--instance/,
    );
    expect(parse(["daemon", "--home", "/x"])).toMatchObject({ home: "/x" });
  });
  it("refuses an empty --home or --instance instead of dropping it", () => {
    for (const argv of [
      ["uninstall", "--purge", "--home="],
      ["uninstall", "--purge", "--home", ""],
      ["install", "--instance="],
      ["login", "--instance", ""],
    ])
      expect(() => parse(argv), argv.join(" ")).toThrow(
        /--(home|instance) needs a value/,
      );
  });
  it("rejects bad input", () => {
    expect(() => parse(["status", "extra"])).toThrow(
      /unexpected argument: extra/,
    );
    expect(() => parse(["mcp", "pi", "extra"])).toThrow(/unexpected argument/);
    expect(() => parse(["--no-color", "wat"])).toThrow(/unknown command: wat/);
    expect(() => parse(["wat"])).toThrow(/unknown command/);
    expect(() => parse(["mcp", "vim"])).toThrow(/usage/);
    expect(() => parse(["mcp"])).toThrow(/usage/);
    expect(() => parse(["status", "--nope"])).toThrow();
  });
});

describe("the oa-bus bin", () => {
  it("runs from the sources", () => {
    const home = mkdtempSync(join(tmpdir(), "ob-bin-"));
    const out = execFileSync(
      process.execPath,
      [new URL("../bin/oa-bus.mjs", import.meta.url).pathname, "version"],
      {
        env: {
          ...process.env,
          HOME: home,
          OA_BUS_HOME: join(home, ".oa-bus"),
        },
        encoding: "utf8",
      },
    );
    expect(out).toMatch(/^oa-bus \d+\.\d+\.\d+\n$/);
  }, 60_000);
});

describe("exec", () => {
  // The hung command is a child that holds a gate the test owns (a unix
  // socket it connects to and then blocks on). The timeout runs on fake time,
  // so nothing here waits it out; the gate is released in cleanup.
  const cleanup: (() => void)[] = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const c of cleanup.splice(0).reverse()) c();
  });

  async function gate() {
    const dir = mkdtempSync(join(tmpdir(), "ob-gate-"));
    const sock = join(dir, "g.sock");
    const held: Socket[] = [];
    const waiting: (() => void)[] = [];
    const server = createServer((s) => {
      s.on("error", () => {});
      held.push(s);
      waiting.shift()?.();
    });
    await new Promise<void>((r) => server.listen(sock, () => r()));
    cleanup.push(() => {
      for (const s of held) s.destroy();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    });
    // The child that blocks on the gate: connect, then wait for a close.
    const blocker = join(dir, "block.mjs");
    writeFileSync(
      blocker,
      `import { connect } from "node:net";
console.log("ready");
const s = connect(${JSON.stringify(sock)});
s.on("error", () => process.exit(0));
s.on("close", () => { console.log("bye"); process.exit(0); });
s.on("data", () => {});
`,
    );
    return {
      dir,
      blocker,
      release: () => {
        for (const s of held.splice(0)) s.destroy();
      },
      /** Resolves once one more child has connected to the gate. */
      connected: () => new Promise<void>((r) => waiting.push(r)),
    };
  }

  const settled = (p: Promise<unknown>) => {
    const state = { done: false };
    void p.then(() => {
      state.done = true;
    });
    return state;
  };

  /** Resolves once this process has read a chunk of a pipe or socket containing `text`. */
  function readSeen(text: string): Promise<void> {
    const emit = Socket.prototype.emit;
    return new Promise((resolve) => {
      const spy = vi
        .spyOn(Socket.prototype, "emit")
        .mockImplementation(function (
          this: Socket,
          ev: string,
          ...a: unknown[]
        ) {
          const ret = Reflect.apply(emit, this, [ev, ...a]) as boolean;
          if (ev === "data" && String(a[0]).includes(text)) {
            spy.mockRestore();
            resolve();
          }
          return ret;
        } as never);
      cleanup.push(() => spy.mockRestore());
    });
  }

  const script = (g: { dir: string; blocker: string }) => {
    const oc = join(g.dir, "opencode");
    writeFileSync(
      oc,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(g.blocker)}\n`,
    );
    chmodSync(oc, 0o755);
    return oc;
  };

  it("a timeout of 0 means no timeout, like execFile", async () => {
    const g = await gate();
    const oc = script(g);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const connected = g.connected();
    const run = makeExec(0)(oc, []);
    const state = settled(run);
    await connected;
    await vi.advanceTimersByTimeAsync(2 ** 31);
    expect(state.done).toBe(false);
    g.release();
    expect(await run).toMatchObject({ code: 0, stdout: "ready\nbye\n" });
  });

  it("an invalid timeout fails before spawning, like execFile", async () => {
    const g = await gate();
    const oc = script(g);
    for (const bad of [
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2 ** 53,
    ]) {
      const r = await makeExec(bad)(oc, []);
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toMatch(/"timeout" is out of range/);
    }
    expect((await makeExec(300)(oc, [], { timeoutMs: -1 })).stderr).toMatch(
      /out of range/,
    );
  });

  it("an argument execFile rejects fails like any command, not by rejecting", async () => {
    const g = await gate();
    const oc = script(g);
    const r = await makeExec(300)(oc, ["a\0b"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/ERR_INVALID_ARG_VALUE/);
  });

  it("returns the output collected before the timeout", async () => {
    const g = await gate();
    const oc = script(g);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const connected = g.connected();
    const read = readSeen("ready");
    const run = makeExec(300)(oc, []);
    await connected;
    await read;
    await vi.advanceTimersByTimeAsync(300);
    expect(await run).toMatchObject({
      code: 1,
      stdout: "ready\n",
      stderr: "timed out after 300 ms",
    });
  });

  it("kills a hung command at its timeout, so a hung opencode reads as version unknown", async () => {
    const g = await gate();
    const oc = join(g.dir, "opencode");
    writeFileSync(
      oc,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(g.blocker)}\n`,
    );
    chmodSync(oc, 0o755);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const exec = makeExec(300);
    const hung = g.connected();
    const run = exec(oc, ["--version"]);
    const state = settled(run);
    await hung;
    // Held at the gate: not killed before its timeout...
    await vi.advanceTimersByTimeAsync(299);
    expect(state.done).toBe(false);
    // ...and killed at it.
    await vi.advanceTimersByTimeAsync(1);
    const r = await run;
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/timed out after 300 ms/);

    const hung2 = g.connected();
    const version = opencodeVersion((_cmd, args) => exec(oc, args));
    await hung2;
    await vi.advanceTimersByTimeAsync(300);
    expect(await version).toBeUndefined();
  });

  it("returns at its timeout even when a child of the command keeps stdout open", async () => {
    const g = await gate();
    const sh = join(g.dir, "opencode");
    // A wrapper script (npm and asdf shims are): the grandchild inherits the
    // pipe and blocks on the gate, which stays held after the wrapper is killed.
    writeFileSync(
      sh,
      `#!/bin/sh\n${JSON.stringify(process.execPath)} ${JSON.stringify(g.blocker)} &\nwait\necho 9.9.9\n`,
    );
    chmodSync(sh, 0o755);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const grandchild = g.connected();
    const run = makeExec(500)(sh, ["--version"]);
    await grandchild;
    await vi.advanceTimersByTimeAsync(500);
    // Resolves while the grandchild still holds the pipe (the gate is open).
    const r = await run;
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/timed out after 500 ms/);
  });
});
