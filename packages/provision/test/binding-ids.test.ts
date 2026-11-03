import { describe, expect, it } from "vitest";
import {
  type BindingIdExpect,
  bindingIdProblems,
  bindingShape,
  doNamespaceDigest,
  plannedBindings,
} from "../src/binding-ids.ts";
import type { SettingsBinding } from "../src/cf.ts";

const enc = (s: string) => new TextEncoder().encode(s);

const D1 = "d1-own";
const KV = "kv-own";
const SCRIPT = "oa-s-abc";
const RL_NS = 1_000_008;
const TEMPLATE = {
  d1_databases: [{ binding: "DB" }],
  r2_buckets: [{ binding: "FILES" }],
  kv_namespaces: [{ binding: "OAUTH_KV" }],
  durable_objects: {
    bindings: [{ name: "RT", class_name: "ArtifactRuntime" }],
  },
  ratelimits: [{ name: "RL_A" }, { name: "RL_B" }],
};
const E: BindingIdExpect = {
  d1Id: D1,
  kvId: KV,
  rowD1Id: D1,
  rowKvId: KV,
  r2: SCRIPT,
  script: SCRIPT,
  planned: plannedBindings(TEMPLATE, RL_NS),
};
const OK: SettingsBinding[] = [
  { type: "d1", name: "DB", id: D1 },
  { type: "kv_namespace", name: "OAUTH_KV", namespace_id: KV },
  { type: "r2_bucket", name: "FILES", bucket_name: SCRIPT },
  { type: "ratelimit", name: "RL_A", namespace_id: "1000008" },
  { type: "ratelimit", name: "RL_B", namespace_id: "1000009" },
  {
    type: "durable_object_namespace",
    name: "RT",
    class_name: "ArtifactRuntime",
  },
  { type: "plain_text", name: "X", text: "y" },
  { type: "secret_text", name: "S" },
  { type: "send_email", name: "EMAIL" },
];
/** OK with one binding changed; the problems' codes. */
const edited = (name: string, over: Record<string, unknown>, e = E) =>
  bindingIdProblems(
    OK.map((b) => (b.name === name ? { ...b, ...over } : b)),
    e,
  ).map((p) => `${p.binding}:${p.code}`);

describe("bindingIdProblems", () => {
  it("an install bound to its own resources has no problems", () => {
    expect(bindingIdProblems(OK, E)).toEqual([]);
  });

  it("flags another install's D1, KV and R2", () => {
    expect(edited("DB", { id: "other" })).toEqual(["DB:d1_foreign"]);
    expect(edited("OAUTH_KV", { namespace_id: "other" })).toEqual([
      "OAUTH_KV:kv_foreign",
    ]);
    expect(edited("FILES", { bucket_name: "oa-s-xyz" })).toEqual([
      "FILES:r2_foreign",
    ]);
  });

  it("flags a live id the row disagrees with", () => {
    expect(edited("DB", {}, { ...E, rowD1Id: "old" })).toEqual(["DB:d1_row"]);
    expect(edited("OAUTH_KV", {}, { ...E, rowKvId: "old" })).toEqual([
      "OAUTH_KV:kv_row",
    ]);
  });

  it("a row with no id yet isn't a problem", () => {
    expect(edited("DB", {}, { ...E, rowD1Id: null })).toEqual([]);
  });

  it("flags a missing id and a name that doesn't resolve", () => {
    expect(edited("DB", { id: undefined })).toEqual(["DB:d1_unreported"]);
    expect(edited("OAUTH_KV", { namespace_id: undefined })).toEqual([
      "OAUTH_KV:kv_unreported",
    ]);
    expect(edited("DB", {}, { ...E, d1Id: null })).toEqual([
      "DB:d1_unresolved",
    ]);
  });

  it("each rate limit has exactly its own namespace", () => {
    expect(edited("RL_A", { namespace_id: 1000008 })).toEqual([]);
    expect(edited("RL_A", { namespace_id: "1000009" })).toEqual([
      "RL_A:ratelimit_foreign",
    ]);
    expect(edited("RL_B", { namespace_id: "2000000" })).toEqual([
      "RL_B:ratelimit_foreign",
    ]);
    expect(edited("RL_A", { namespace_id: undefined })).toEqual([
      "RL_A:ratelimit_unreported",
    ]);
  });

  it("the Durable Object class comes from the template", () => {
    expect(edited("RT", { class_name: "Other" })).toEqual(["RT:do_class"]);
    expect(edited("RT", { script_name: SCRIPT })).toEqual([]);
    expect(edited("RT", { script_name: "oa-s-xyz" })).toEqual([
      "RT:do_foreign_script",
    ]);
  });

  it("flags a declared binding that's missing", () => {
    for (const name of ["DB", "OAUTH_KV", "FILES", "RT", "RL_B"]) {
      const live = OK.filter((b) => b.name !== name);
      expect(bindingIdProblems(live, E)).toEqual([
        { binding: name, code: "missing" },
      ]);
    }
  });

  it("flags a resource binding the template doesn't declare", () => {
    expect(
      bindingIdProblems([...OK, { type: "d1", name: "EXTRA", id: D1 }], E).map(
        (p) => p.code,
      ),
    ).toEqual(["not_in_template"]);
  });

  it("reports a binding type it doesn't know", () => {
    expect(
      bindingIdProblems([...OK, { type: "queue", name: "Q" }], E).map(
        (p) => p.code,
      ),
    ).toEqual(["unknown_type_queue"]);
  });

  it("names the binding and a code, never an id", () => {
    const text = JSON.stringify(edited("DB", { id: "secret-id" }));
    expect(text).toContain("DB");
    expect(text).not.toContain("secret-id");
  });
});

describe("doNamespaceDigest", () => {
  const h = (b: Uint8Array) => Buffer.from(b).toString("hex");
  it("is empty when none is reported, and doesn't show an id", () => {
    expect(doNamespaceDigest(OK, h)).toBe("");
    const live = [
      { type: "durable_object_namespace", name: "A", namespace_id: "b" },
      { type: "durable_object_namespace", name: "B", namespace_id: "a" },
    ];
    expect(doNamespaceDigest(live, h)).toBe(h(enc("a,b")).slice(0, 16));
    expect(doNamespaceDigest([...live].reverse(), h)).toBe(
      doNamespaceDigest(live, h),
    );
  });
});

describe("bindingShape", () => {
  it("lists field names by type, never a value", () => {
    const s = bindingShape([
      { type: "d1", name: "DB", id: "secret-id" },
      { type: "d1", name: "DB2", id: "x", extra: 1 },
      { type: "ai", name: "AI" },
    ]);
    expect(s).toBe("ai:name,type;d1:extra,id,name,type");
    expect(s).not.toContain("secret-id");
  });
});
