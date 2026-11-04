import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StatusReply } from "@oa/bus-ipc";
import { vi } from "vitest";
import { type Ctx, noService } from "../src/context.ts";
import { copy } from "../src/copy.ts";
import type { Style } from "../src/term.ts";

export const TOKEN = `oa_machine_${"a".repeat(28)}7f3a`;
export const CODE = "K3M7-QW29";
export const HUB = "https://bus.example.com";
export const URL_ = `${HUB}/approve/${CODE}`;
export const LABEL = "leo-macbook-pro";
export const NS = "github.com/open-artifacts-ai/oa-bus";
export const TAGS: Style = { color: "tags", dark: true, utf8: true };

/** The transcript's fenced blocks under `heading`, in order. */
export function transcript(heading: string): string[][] {
  const md = readFileSync(
    new URL("../design/transcript.md", import.meta.url),
    "utf8",
  );
  const start = md.indexOf(heading);
  if (start < 0) throw new Error(`no ${heading} in transcript.md`);
  const rest = md.slice(start + heading.length);
  const end = rest.search(/\n## /);
  const section = end < 0 ? rest : rest.slice(0, end);
  return [...section.matchAll(/```\n([\s\S]*?)```/g)].map((m) =>
    (m[1] as string).replace(/\n$/, "").split("\n"),
  );
}

export const deviceCode = () =>
  Response.json({
    device_code: "d".repeat(43),
    user_code: CODE,
    verification_uri: URL_,
    expires_in: 600,
    interval: 5,
  });

export const status = (over: Partial<StatusReply> = {}): StatusReply => ({
  v: 1,
  id: "status",
  type: "status",
  pid: 48213,
  version: "0.1.0",
  label: LABEL,
  hub: "connected",
  namespace: NS,
  namespaces: [{ namespace: NS, agents: [] }],
  ...over,
});

export type Fake = Ctx & {
  out: () => string[];
  err: () => string[];
  /** stdout and stderr interleaved, as a terminal shows them. */
  all: () => string[];
  raw: () => string;
  clock: { t: number };
};

/** A ctx on temp homes, fake network, clock, PATH and daemon; never the real ones. */
export function fakeCtx(over: Partial<Ctx> = {}, tty = false): Fake {
  const userHome = mkdtempSync(join(tmpdir(), "ob-cli-home-"));
  const home = join(userHome, ".oa-bus");
  mkdirSync(userHome, { recursive: true });
  let stdout = "";
  let stderr = "";
  let both = "";
  const clock = { t: 1_000_000 };
  const style = over.style ?? TAGS;
  const ctx: Ctx = {
    fetch: vi.fn(async () => {
      throw new Error("no network in tests");
    }) as unknown as typeof fetch,
    openBrowser: vi.fn(async () => true),
    sleep: vi.fn(async (ms: number) => {
      clock.t += ms;
    }),
    print: vi.fn(),
    now: () => clock.t,
    exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    stdout: {
      write: (s: string) => {
        stdout += s;
        both += s;
      },
      isTTY: tty,
    },
    stderr: {
      write: (s: string) => {
        stderr += s;
        both += s;
      },
    },
    env: {},
    cwd: "/work/oa-bus",
    userHome,
    home,
    which: () => false,
    service: noService,
    status: vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }),
    version: "0.1.0",
    style,
    copy: copy(style),
    platform: "darwin arm64",
    nodeVersion: "v24.0.0",
    ...over,
  };
  const lines = (s: string) => s.replace(/\n$/, "").split("\n");
  return Object.assign(ctx, {
    out: () => (stdout ? lines(stdout) : []),
    err: () => (stderr ? lines(stderr) : []),
    all: () => (both ? lines(both) : []),
    raw: () => stdout,
    clock,
  });
}
