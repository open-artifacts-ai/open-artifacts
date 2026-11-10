import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonSocketPath } from "@oa/bus-adapter-claude-code";
import { type Hello, serveDaemon } from "@oa/bus-ipc";
import { build } from "esbuild";
import { afterEach, expect, it } from "vitest";
import { Bus } from "../src/bus.ts";
import { realConnect } from "../src/link.ts";
import { caller, flush } from "./support.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

it("says hello to a daemon as an openclaw kind, with the root's identity, and takes a push", async () => {
  const home = mkdtempSync(join(tmpdir(), "ocb-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const hellos: Hello[] = [];
  const acks: string[] = [];
  let push: ((f: never) => void) | undefined;
  const server = await serveDaemon({
    path: daemonSocketPath(home),
    onHello: (h) => {
      hellos.push(h);
      return { bus_name: "openclaw-1", namespace: "ns", global: false };
    },
    onFrame: (f) => {
      if (f.type === "ack") acks.push(f.msg_id);
      if (f.type === "self")
        return {
          type: "agent",
          agent: {
            name: "openclaw-1",
            namespace: "ns",
            kind: "openclaw",
            live: true,
            global: false,
          },
        };
      return undefined;
    },
    onOpen: (_h, p) => {
      push = p as never;
      p({
        v: 1,
        id: "d1",
        type: "deliver",
        msg_id: "mmmmmmmmmmmmmmm1",
        from_name: "bob",
        namespace: "ns",
        body: "over the socket",
      });
    },
  });
  cleanup.push(() => server.close());
  const bus = new Bus({
    connect: realConnect({ OA_BUS_HOME: home }),
    stateDir: () => "/state/.openclaw",
  });
  bus.buildPrompt(caller({ runId: "w", workspaceDir: "/work/space" }));
  await new Promise((r) => setTimeout(r, 300));
  expect(push).toBeDefined();
  expect(hellos).toHaveLength(1);
  expect(hellos[0]).toMatchObject({
    kind: "openclaw",
    pid: process.pid,
    cwd: "/work/space",
    proposed_name: "openclaw-main",
    caps: ["mailbox", "pending", "follow", "link"],
  });
  expect(hellos[0]?.agent_ref).toMatch(/^oa-[0-9a-f]{40}$/);
  expect(hellos[0]?.attest.proc_start).toBeTruthy();
  bus.modelCallStarted(
    { agentId: "main", sessionKey: "agent:main:main" },
    { runId: "w" },
  );
  const r = bus.buildPrompt(caller({ runId: "r1" }));
  expect(r?.prependContext).toContain("over the socket");
  bus.modelCallEnded(
    { agentId: "main", sessionKey: "agent:main:main" },
    { runId: "r1", outcome: "completed" },
  );
  await flush();
  await flush();
  expect(acks).toEqual(["mmmmmmmmmmmmmmm1"]);
  bus.closeAll();
});

it("does not keep its host process alive once the turn is over", async () => {
  const home = mkdtempSync(join(tmpdir(), "ocb-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const server = await serveDaemon({
    path: daemonSocketPath(home),
    onHello: () => ({ bus_name: "openclaw-1", namespace: "ns", global: false }),
    onFrame: () => undefined,
  });
  cleanup.push(() => server.close());
  // The sources use TypeScript that strip-only mode cannot run: bundle the child.
  const script = join(home, "child.mjs");
  await build({
    entryPoints: [join(import.meta.dirname, "unref-child.ts")],
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
  const child = await new Promise<{ status: number | null; out: string }>(
    (resolve) => {
      const p = spawn(process.execPath, [script, home], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      let out = "";
      p.stdout.on("data", (d) => {
        out += d;
      });
      const kill = setTimeout(() => p.kill("SIGKILL"), 8000);
      p.on("close", (status) => {
        clearTimeout(kill);
        resolve({ status, out });
      });
    },
  );
  expect(child.out.trim()).toBe("link-open");
  expect(child.status).toBe(0);
}, 15000);
