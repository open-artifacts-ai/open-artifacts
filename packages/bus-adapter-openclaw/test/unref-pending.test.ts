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
    // The child reports whether the socket holds its loop while the request
    // is pending, so the answer can come at once: no wall time to wait out.
    onFrame: (f, _h, reply) => {
      if (f.type === "list")
        setImmediate(() =>
          reply({ v: 1, id: f.id, type: "roster", agents: [] }),
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
  }>((resolve) => {
    const p = spawn(process.execPath, [script, daemonSocketPath(home)], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let o = "";
    p.stdout.on("data", (d) => {
      o += d;
    });
    // A safety net only: the assertion below is the child's own report that
    // the socket let go of its loop (held:false), not how long it took.
    const kill = setTimeout(() => p.kill("SIGKILL"), 8000);
    p.on("close", (status) => {
      clearTimeout(kill);
      resolve({ status, out: o });
    });
  });
  // Held while the request was pending, answered, and gone once idle.
  expect(out.out.trim().split("\n")).toEqual([
    "held:true",
    "reply:roster",
    "held:false",
  ]);
  expect(out.status).toBe(0);
}, 15000);
