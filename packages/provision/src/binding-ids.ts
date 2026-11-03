import type { SettingsBinding } from "./cf.js";
import type { Template } from "./metadata.js";

// verify_clean compares bindings by name and type. This compares the real ids
// a live script is bound to with values that don't come from the render being
// checked: the install's own resource names, resolved by name, its rl_ns, and
// the release's template.
// Stage 1 (#1137): an audit line only. Nothing here refuses a job.

/** A resource binding the release's template declares. */
export interface PlannedBinding {
  type: string;
  name: string;
  /** durable_object_namespace: the class it must bind. */
  className?: string;
  /** ratelimit: the namespace this install must use. */
  namespaceId?: string;
}

/** What this install's script may be bound to. */
export interface BindingIdExpect {
  /** D1 and KV ids resolved by name; null when the name doesn't resolve. */
  d1Id: string | null;
  kvId: string | null;
  /** The ids on the installs row; null before they're recorded. */
  rowD1Id: string | null;
  rowKvId: string | null;
  r2: string;
  script: string;
  /** From the release's template, not from the render being checked. */
  planned: readonly PlannedBinding[];
}

/** The resource bindings a template declares, with this install's rl_ns. */
export function plannedBindings(t: Template, rlNs: number): PlannedBinding[] {
  const names = (k: string, type: string) =>
    ((t[k] ?? []) as { binding: string }[]).map((e) => ({
      type,
      name: e.binding,
    }));
  return [
    ...names("d1_databases", "d1"),
    ...names("r2_buckets", "r2_bucket"),
    ...names("kv_namespaces", "kv_namespace"),
    ...(
      (t.durable_objects?.bindings ?? []) as {
        name: string;
        class_name: string;
      }[]
    ).map((e) => ({
      type: "durable_object_namespace",
      name: e.name,
      className: e.class_name,
    })),
    ...((t.ratelimits ?? []) as { name: string }[]).map((e, k) => ({
      type: "ratelimit",
      name: e.name,
      namespaceId: String(rlNs + k),
    })),
  ];
}

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
  const plan = (b: SettingsBinding) =>
    e.planned.find((p) => p.type === b.type && p.name === b.name);
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
        const want = plan(b)?.namespaceId;
        if (b.namespace_id === undefined) add(b, "ratelimit_unreported");
        else if (want !== undefined && String(b.namespace_id) !== want)
          add(b, "ratelimit_foreign");
        break;
      }
      case "durable_object_namespace": {
        const want = plan(b)?.className;
        if (want !== undefined && b.class_name !== want) add(b, "do_class");
        if (b.script_name !== undefined && b.script_name !== e.script)
          add(b, "do_foreign_script");
        break;
      }
      default:
        if (!NO_ID_TYPES.includes(b.type)) add(b, `unknown_type_${b.type}`);
        continue;
    }
    if (!plan(b)) add(b, "not_in_template");
  }
  for (const p of e.planned)
    if (!live.some((b) => b.type === p.type && b.name === p.name))
      out.push({ binding: p.name, code: "missing" });
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

/**
 * A short digest of the live Durable Object namespace ids, or "" when none is
 * reported. Stage 1 has no expected value for them, but two installs showing
 * the same digest would be a crossing. Stage 2 decides what to do with it.
 */
export function doNamespaceDigest(
  live: readonly SettingsBinding[],
  sha256: (bytes: Uint8Array) => string,
): string {
  const ids = live
    .filter((b) => b.type === "durable_object_namespace" && b.namespace_id)
    .map((b) => String(b.namespace_id))
    .sort();
  if (ids.length === 0) return "";
  return sha256(new TextEncoder().encode(ids.join(","))).slice(0, 16);
}
