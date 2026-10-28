// The hosted-ops workflow's input validator (OPS-B). Workflow inputs reach
// this file only through env (OPS_ENV, OPS_OP, OPS_INSTALL, OPS_TAG,
// OPS_ARGS, OPS_CONFIRM), never through shell text. It checks them against an
// allowlist of operations and a per-op schema, and prints the oa:hosted argv
// as one JSON array of strings: the workflow passes those as separate argv
// entries, so no value is ever parsed by a shell.
//
// - op: one of OPS; env: staging or prod.
// - install: an install id where the op needs one, empty where it takes none.
// - tag: a stable vX.Y.Z where the op needs one (create, upgrade: --to;
//   publish-release: --tag), empty otherwise.
// - args: a JSON object with only the op's keys (ARG_KEYS), each typed.
//   update-vars and create take var: ["K=V", ...] with only the var names
//   the CLI accepts (provision's hostedVarProblem).
// - confirm: equal to install for delete and release-lease, empty otherwise.
// - create, upgrade, rollback, update-vars get --ci-owner-token.
// - publish-floor: args.floor is the signed floor ({ record, signature }) a
//   hosted-floor run produced; it is written to OPS_FLOOR_FILE and passed as
//   --floor. publishFloor verifies its signature, so the input is not trusted.
//
// GITHUB_OUTPUT (when set) gets `install=<id>` for an op that runs with
// --ci-owner-token and names its install, so the always() sweep knows it.
import { appendFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  HOSTED_DOMAINS,
  hostedVarProblem,
  hosts,
  isInstallId,
  isReleaseVersion,
  normOwnerEmail,
} from "@oa/provision";

export const OPS = [
  "create",
  "upgrade",
  "rollback",
  "update-vars",
  "status",
  "delete",
  "release-lease",
  "turnstile-init",
  "publish-release",
  "publish-floor",
] as const;
export type Op = (typeof OPS)[number];

/** Ops that run their selftest on the ephemeral CI owner token. */
export const CI_TOKEN_OPS: readonly Op[] = [
  "create",
  "upgrade",
  "rollback",
  "update-vars",
];

const NEEDS_INSTALL: readonly Op[] = [
  "upgrade",
  "rollback",
  "update-vars",
  "status",
  "delete",
  "release-lease",
];
/** create may name an install: it resumes that create. */
const MAY_INSTALL: readonly Op[] = ["create"];
const NEEDS_TAG: readonly Op[] = ["create", "upgrade", "publish-release"];
const NEEDS_CONFIRM: readonly Op[] = ["delete", "release-lease"];

/** The keys each op's `args` may hold. */
export const ARG_KEYS: Record<Op, readonly string[]> = {
  create: ["slug", "owner", "to", "var", "testHooks"],
  upgrade: [],
  rollback: [],
  "update-vars": ["var"],
  status: [],
  delete: ["skipDirectoryRevoke"],
  "release-lease": ["force"],
  "turnstile-init": [],
  "publish-release": [],
  "publish-floor": ["floor"],
};

export class ArgsRefused extends Error {
  override name = "ArgsRefused";
}

export interface Inputs {
  env: string;
  op: string;
  install: string;
  tag: string;
  args: string;
  confirm: string;
}

export interface Plan {
  argv: string[];
  /** The install the CI token is minted in, when the op names one. */
  sweep: string | null;
  /** publish-floor: the canonical signed floor JSON to write. */
  floor?: string;
}

const STABLE_TAG = /^v\d+\.\d+\.\d+$/;
/** Printable ASCII only: no control characters, newlines or NULs anywhere. */
const PRINTABLE = /^[\x20-\x7e]*$/;
const MAX_ARGS = 16_384;
const MAX_VARS = 64;
const FLOOR_PART = /^[A-Za-z0-9+/=_.:,{}"[\]\- ]+$/;

function refuse(m: string): never {
  throw new ArgsRefused(m);
}

/** A string value that can never read as a flag or carry a control character. */
function plain(v: unknown, what: string, max = 512): string {
  if (typeof v !== "string") refuse(`${what} must be a string`);
  const s = v as string;
  if (s === "" || s.length > max) refuse(`${what} is empty or too long`);
  if (!PRINTABLE.test(s)) refuse(`${what} has a character that is not printable ASCII`);
  if (s.startsWith("-")) refuse(`${what} may not start with "-"`);
  return s;
}

function varsOf(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_VARS)
    refuse(`${what} must be a non-empty list of "NAME=value"`);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const kv of v as unknown[]) {
    const s = typeof kv === "string" ? kv : refuse(`${what}: each entry is a string`);
    if (!PRINTABLE.test(s)) refuse(`${what}: a value has a character that is not printable ASCII`);
    if (s.length > 2048) refuse(`${what}: an entry is too long`);
    const i = s.indexOf("=");
    const k = i > 0 ? s.slice(0, i) : "";
    if (!/^[A-Z][A-Z0-9_]*$/.test(k))
      refuse(`${what}: each entry is NAME=value with an uppercase NAME`);
    if (seen.has(k)) refuse(`${what}: ${k} given twice`);
    seen.add(k);
    const why = hostedVarProblem(k, s.slice(i + 1));
    if (why) refuse(`${what}: ${why}`);
    out.push(s);
  }
  return out;
}

function parseArgsJson(raw: string, op: Op): Record<string, unknown> {
  const text = raw.trim() === "" ? "{}" : raw;
  if (text.length > MAX_ARGS) refuse("args is too long");
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    refuse("args is not JSON");
  }
  if (v === null || typeof v !== "object" || Array.isArray(v))
    refuse("args must be a JSON object");
  const o = v as Record<string, unknown>;
  const allowed = ARG_KEYS[op];
  for (const k of Object.keys(o))
    if (!allowed.includes(k))
      refuse(
        allowed.length === 0
          ? `${op} takes no args`
          : `args.${k.slice(0, 40)} is not one of ${op}'s (${allowed.join(", ")})`,
      );
  return o;
}

/** The signed floor, re-serialized: only { record, signature } strings. */
function floorOf(v: unknown, env: string): string {
  if (v === null || typeof v !== "object" || Array.isArray(v))
    refuse("args.floor must be the signed floor object");
  const f = v as Record<string, unknown>;
  const keys = Object.keys(f).sort();
  if (keys.join(",") !== "record,signature")
    refuse("args.floor must have exactly record and signature");
  for (const k of ["record", "signature"] as const) {
    const s = f[k];
    if (typeof s !== "string" || s === "" || s.length > 8192 || !FLOOR_PART.test(s))
      refuse(`args.floor.${k} is not a signed floor part`);
  }
  let rec: unknown;
  try {
    rec = JSON.parse(f.record as string);
  } catch {
    refuse("args.floor.record is not JSON");
  }
  if ((rec as { env?: unknown })?.env !== env)
    refuse(`args.floor is not a ${env} floor`);
  return JSON.stringify({ record: f.record, signature: f.signature });
}

export function plan(i: Inputs, floorFile?: string): Plan {
  for (const [k, v] of Object.entries(i))
    if (typeof v !== "string") refuse(`${k} must be a string`);
  const op = i.op as Op;
  if (!(OPS as readonly string[]).includes(op))
    refuse(`op must be one of ${OPS.join(", ")}`);
  const env = i.env;
  if (env !== "staging" && env !== "prod")
    refuse("env must be staging or prod");
  const argv: string[] = [op, "--env", env];

  // install
  if (i.install !== "") {
    if (!isInstallId(i.install)) refuse("install is not an install id");
    if (!NEEDS_INSTALL.includes(op) && !MAY_INSTALL.includes(op))
      refuse(`${op} takes no install`);
    argv.push("--install", i.install);
  } else if (NEEDS_INSTALL.includes(op)) refuse(`${op} needs an install`);

  // confirm
  if (NEEDS_CONFIRM.includes(op)) {
    if (i.confirm !== i.install)
      refuse(`${op} needs confirm to be exactly the install id`);
    argv.push("--confirm", i.install);
  } else if (i.confirm !== "") refuse(`${op} takes no confirm`);

  // tag
  let version: string | undefined;
  if (i.tag !== "") {
    if (!NEEDS_TAG.includes(op)) refuse(`${op} takes no tag`);
    if (!STABLE_TAG.test(i.tag) || !isReleaseVersion(i.tag.slice(1)))
      refuse("tag must be a stable release tag like v1.2.3");
    version = i.tag.slice(1);
  }

  const a = parseArgsJson(i.args, op);
  let floor: string | undefined;
  switch (op) {
    case "create": {
      const slug = plain(a.slug, "args.slug", 32);
      try {
        hosts(slug, HOSTED_DOMAINS[env]);
      } catch {
        refuse("args.slug is not a valid install slug");
      }
      const owner = plain(a.owner, "args.owner", 320);
      if (normOwnerEmail(owner) === null) refuse("args.owner is not an email");
      if (a.to !== undefined) {
        const to = plain(a.to, "args.to", 32);
        if (!isReleaseVersion(to)) refuse("args.to is not a release version");
        if (version !== undefined && to !== version)
          refuse("args.to and tag name different versions");
        version = to;
      }
      if (version === undefined) refuse("create needs a tag (or args.to)");
      argv.push("--slug", slug, "--owner", owner, "--to", version as string);
      if (a.var !== undefined)
        for (const kv of varsOf(a.var, "args.var")) argv.push("--var", kv);
      if (a.testHooks !== undefined) {
        if (typeof a.testHooks !== "boolean")
          refuse("args.testHooks must be a boolean");
        if (a.testHooks) {
          if (env !== "staging") refuse("args.testHooks is staging only");
          argv.push("--test-hooks");
        }
      }
      break;
    }
    case "upgrade":
      if (version === undefined) refuse("upgrade needs a tag");
      argv.push("--to", version as string);
      break;
    case "update-vars":
      for (const kv of varsOf(a.var, "args.var")) argv.push("--var", kv);
      break;
    case "delete":
      if (a.skipDirectoryRevoke !== undefined)
        argv.push(
          "--skip-directory-revoke",
          plain(a.skipDirectoryRevoke, "args.skipDirectoryRevoke", 200),
        );
      break;
    case "release-lease":
      if (a.force !== undefined) {
        if (typeof a.force !== "boolean") refuse("args.force must be a boolean");
        if (a.force) argv.push("--force");
      }
      break;
    case "publish-release":
      if (version === undefined) refuse("publish-release needs a tag");
      argv.push("--tag", `v${version}`);
      break;
    case "publish-floor": {
      floor = floorOf(a.floor, env);
      if (!floorFile || !floorFile.startsWith("/"))
        refuse("publish-floor needs OPS_FLOOR_FILE (an absolute path)");
      argv.push("--floor", floorFile as string);
      break;
    }
    default:
      break;
  }

  const ci = CI_TOKEN_OPS.includes(op);
  if (ci) argv.push("--ci-owner-token");
  return {
    argv,
    sweep: ci && i.install !== "" ? i.install : null,
    ...(floor === undefined ? {} : { floor }),
  };
}

export function run(
  env: Record<string, string | undefined>,
  io: {
    out: (s: string) => void;
    err: (s: string) => void;
    writeFile: (path: string, data: string) => void;
    appendFile: (path: string, data: string) => void;
  },
): number {
  let p: Plan;
  try {
    p = plan(
      {
        env: env.OPS_ENV ?? "",
        op: env.OPS_OP ?? "",
        install: env.OPS_INSTALL ?? "",
        tag: env.OPS_TAG ?? "",
        args: env.OPS_ARGS ?? "",
        confirm: env.OPS_CONFIRM ?? "",
      },
      env.OPS_FLOOR_FILE,
    );
  } catch (e) {
    if (!(e instanceof ArgsRefused)) throw e;
    io.err(`hosted-ops: refused: ${e.message}`);
    return 1;
  }
  if (p.floor !== undefined)
    io.writeFile(env.OPS_FLOOR_FILE as string, p.floor);
  if (env.GITHUB_OUTPUT)
    io.appendFile(env.GITHUB_OUTPUT, `install=${p.sweep ?? ""}\n`);
  io.out(JSON.stringify(p.argv));
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = run(process.env, {
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
    writeFile: (path, data) =>
      writeFileSync(path, data, { mode: 0o600, flag: "wx" }),
    appendFile: (path, data) => appendFileSync(path, data),
  });
}
