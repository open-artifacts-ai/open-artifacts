import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";

// T19's two targets (docs: the T19 plan). rl-a comes from REDLINE_TARGETS
// (the red-line suite's JSON, its `a` install); leo from T19_LEO_APP. Paths
// only: the hook key stays in its 0600 file and is read here, never logged.
// Locally the JSON names it (a.hookKeyFile); CI's has none and names
// secretsDir, holding REDLINE_RL_A_HOOK_KEY (the red-line suite's layout).

export type Install = {
  name: string;
  installId: string;
  app: string;
  /** Users the hooks may create: <anything>@testDomain. */
  testDomain: string;
};

const fail = (why: string): never => {
  throw new Error(`T19 targets: ${why}`);
};

const httpsOrigin = (v: unknown, what: string): string => {
  if (typeof v !== "string") return fail(`${what} is missing`);
  const u = new URL(v);
  if (u.protocol !== "https:" || u.origin !== v)
    fail(`${what} must be a bare https origin`);
  return v;
};

const raw = () => {
  const env = process.env.REDLINE_TARGETS;
  if (!env) return fail("set REDLINE_TARGETS (the red-line targets JSON)");
  const t = JSON.parse(env) as {
    mode?: unknown;
    secretsDir?: unknown;
    a?: Record<string, unknown>;
  };
  if (t.mode !== "staging") fail("REDLINE_TARGETS.mode must be staging");
  return {
    a: t.a ?? fail("REDLINE_TARGETS.a is missing"),
    secretsDir:
      typeof t.secretsDir === "string" && t.secretsDir !== ""
        ? t.secretsDir
        : undefined,
  };
};

/** a.hookKeyFile, else CI's <secretsDir>/REDLINE_RL_A_HOOK_KEY. */
const hookKeyFileOf = (
  a: Record<string, unknown>,
  secretsDir: string | undefined,
): string =>
  typeof a.hookKeyFile === "string" && a.hookKeyFile !== ""
    ? a.hookKeyFile
    : secretsDir
      ? join(secretsDir, "REDLINE_RL_A_HOOK_KEY")
      : fail("a.hookKeyFile (or secretsDir) is missing");

/** rl-a: the staging install with test hooks. */
export const rlA = (): Install & { hookKeyFile: string } => {
  const { a, secretsDir } = raw();
  if (a.name !== "rl-a") fail("REDLINE_TARGETS.a must be rl-a");
  return {
    name: "rl-a",
    installId: String(a.installId ?? fail("a.installId is missing")),
    app: httpsOrigin(a.app, "a.app"),
    testDomain: String(
      a.testDomain ?? fail("a.testDomain is missing"),
    ).toLowerCase(),
    hookKeyFile: hookKeyFileOf(a, secretsDir),
  };
};

/** leo: the user's install. Read-only, anonymous checks only. */
export const LEO = httpsOrigin(
  process.env.T19_LEO_APP ?? "https://leo.open-artifacts-staging.app",
  "T19_LEO_APP",
);

/** The hook key, from a 0600 file only. */
export const hookKey = (file: string): string => {
  const fd = openSync(file, "r");
  try {
    if ((fstatSync(fd).mode & 0o077) !== 0)
      fail("the hook key file must be 0600");
    const key = readFileSync(fd, "utf8").trim();
    return key || fail("the hook key file is empty");
  } finally {
    closeSync(fd);
  }
};

/** Every T19 fetch is bounded: a hung request fails the case, not the run. */
export const FETCH_MS = 30_000;
