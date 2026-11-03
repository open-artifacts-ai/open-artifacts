import type { SettingsBinding } from "./cf.js";

// verify_clean compares bindings by name and type. This compares the real ids
// a live script is bound to with values that don't come from the render being
// checked: the install's own resource names, resolved by name, and its rl_ns.
// Stage 1 (#1137): an audit line only. Nothing here refuses a job.

/** What this install's script may be bound to. */
export interface BindingIdExpect {
  /** D1 and KV ids resolved by name; null when the name doesn't resolve. */
  d1Id: string | null;
  kvId: string | null;
  /** The ids on the installs row; null before they're recorded. */
  rowD1Id: string | null;
  rowKvId: string | null;
  r2: string;
  /** installs.rl_ns: this install owns [rl_ns, rl_ns + RL_NS_STRIDE). */
  rlNs: number;
  script: string;
  /** The Durable Object classes of the render. */
  classes: readonly string[];
}

/** installs.rl_ns is unique and a multiple of 8 (0001_installs.sql). */
export const RL_NS_STRIDE = 8;

/** Binding types that hold no reference to any resource. */
const NO_ID_TYPES: readonly string[] = Object.freeze([
  "plain_text",
  "json",
  "secret_text",
  "secret_key",
  "browser",
  "send_email",
  "assets",
  "version_metadata",
]);

/** One problem: a binding's name and a fixed code, never an id. */
export interface BindingIdProblem {
  binding: string;
  code: string;
}

/** Every way `live` isn't this install's own. Empty when all of it is. */
export function bindingIdProblems(
  live: readonly SettingsBinding[],
  e: BindingIdExpect,
): BindingIdProblem[] {
  const out: BindingIdProblem[] = [];
  const add = (b: SettingsBinding, code: string) =>
    out.push({ binding: b.name, code });
  const own = (
    b: SettingsBinding,
    field: string,
    resolved: string | null,
    row: string | null,
    label: string,
  ) => {
    const got = b[field];
    if (typeof got !== "string" || got === "") add(b, `${label}_unreported`);
    else if (resolved === null) add(b, `${label}_unresolved`);
    else if (got !== resolved) add(b, `${label}_foreign`);
    else if (row !== null && got !== row) add(b, `${label}_row`);
  };
  for (const b of live) {
    switch (b.type) {
      case "d1":
        own(b, "id", e.d1Id, e.rowD1Id, "d1");
        break;
      case "kv_namespace":
        own(b, "namespace_id", e.kvId, e.rowKvId, "kv");
        break;
      case "r2_bucket":
        own(b, "bucket_name", e.r2, null, "r2");
        break;
      case "ratelimit": {
        const n = Number(b.namespace_id);
        if (b.namespace_id === undefined) add(b, "ratelimit_unreported");
        else if (
          !Number.isInteger(n) ||
          n < e.rlNs ||
          n >= e.rlNs + RL_NS_STRIDE
        )
          add(b, "ratelimit_foreign");
        break;
      }
      case "durable_object_namespace":
        if (!e.classes.includes(String(b.class_name))) add(b, "do_class");
        if (b.script_name !== undefined && b.script_name !== e.script)
          add(b, "do_foreign_script");
        break;
      default:
        if (!NO_ID_TYPES.includes(b.type)) add(b, `unknown_type_${b.type}`);
    }
  }
  return out;
}

/**
 * The live binding fields by type, names only, never a value: what the
 * settings GET really reports, which nothing has read yet.
 */
export function bindingShape(live: readonly SettingsBinding[]): string {
  const byType = new Map<string, Set<string>>();
  for (const b of live) {
    const s = byType.get(b.type) ?? new Set<string>();
    for (const k of Object.keys(b)) s.add(k);
    byType.set(b.type, s);
  }
  return [...byType.keys()]
    .sort()
    .map((t) => `${t}:${[...(byType.get(t) ?? [])].sort().join(",")}`)
    .join(";");
}
