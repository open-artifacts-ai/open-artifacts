import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonSocketPath } from "@oa/bus-adapter-claude-code";
import { serveDaemon } from "@oa/bus-ipc";
import { build } from "esbuild";
import { afterEach, expect, it } from "vitest";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

// The socket is ref'd while a request waits for its answer, and unref'd when idle:
// a host that has nothing else to do must neither exit with a reply owed nor hang after.
it("holds the process only while a request is pending", async () => {
  const home = mkdtempSync(join(tmpdir(), "ocu-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const server = await serveDaemon({
    path: daemonSocketPath(home),
    onHello: () => ({ bus_name: "openclaw-1", namespace: "ns", global: false }),
    // Answers a request late: 500 ms after it is asked.
    onFrame: (f, _h, reply) => {
      if (f.type === "list")
        setTimeout(
          () => reply({ v: 1, id: f.id, type: "roster", agents: [] }),
          500,
        );
      return undefined;
    },
  });
  cleanup.push(() => server.close());
  const src = join(import.meta.dirname, "unref-pending-child.ts");
  const script = join(home, "child.mjs");
  await build({
    entryPoints: [src],
    outfile: script,
    bundle: true,
    platform: "node",
    format: "esm",
    mainFields: ["module", "main"],
    banner: {
      js: 'import { createRequire as r } from "node:module"; const require = r(import.meta.url);',
    },
    logLevel: "silent",
  });
  const out = await new Promise<{
    status: number | null;
    out: string;
    ms: number;
  }>((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [script, daemonSocketPath(home)], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let o = "";
    p.stdout.on("data", (d) => {
      o += d;
    });
    const kill = setTimeout(() => p.kill("SIGKILL"), 8000);
    p.on("close", (status) => {
      clearTimeout(kill);
      resolve({ status, out: o, ms: Date.now() - t0 });
    });
  });
  expect(out.out.trim()).toBe("reply:roster"); // not gone before the answer
  expect(out.status).toBe(0); // and gone once idle
  expect(out.ms).toBeLessThan(6000);
}, 15000);
