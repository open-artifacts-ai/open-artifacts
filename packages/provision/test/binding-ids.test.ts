import { describe, expect, it } from "vitest";
import {
  type BindingIdExpect,
  bindingIdProblems,
  bindingShape,
} from "../src/binding-ids.ts";

const D1 = "d1-own";
const KV = "kv-own";
const SCRIPT = "oa-s-abc";
const E: BindingIdExpect = {
  d1Id: D1,
  kvId: KV,
  rowD1Id: D1,
  rowKvId: KV,
  r2: SCRIPT,
  rlNs: 1_000_008,
  script: SCRIPT,
  classes: ["ArtifactRuntime"],
};
const OK = [
  { type: "d1", name: "DB", id: D1 },
  { type: "kv_namespace", name: "OAUTH_KV", namespace_id: KV },
  { type: "r2_bucket", name: "FILES", bucket_name: SCRIPT },
  { type: "ratelimit", name: "RL_A", namespace_id: "1000008" },
  { type: "ratelimit", name: "RL_B", namespace_id: "1000015" },
  {
    type: "durable_object_namespace",
    name: "RT",
    class_name: "ArtifactRuntime",
  },
  { type: "plain_text", name: "X", text: "y" },
  { type: "secret_text", name: "S" },
  { type: "send_email", name: "EMAIL" },
];
const only = (b: Record<string, unknown>, e = E) =>
  bindingIdProblems(
    [{ name: "B", type: "x", ...b } as (typeof OK)[number]],
    e,
  ).map((p) => p.code);

describe("bindingIdProblems", () => {
  it("an install bound to its own resources has no problems", () => {
    expect(bindingIdProblems(OK, E)).toEqual([]);
  });

  it("flags another install's D1, KV and R2", () => {
    expect(only({ type: "d1", id: "other" })).toEqual(["d1_foreign"]);
    expect(only({ type: "kv_namespace", namespace_id: "other" })).toEqual([
      "kv_foreign",
    ]);
    expect(only({ type: "r2_bucket", bucket_name: "oa-s-xyz" })).toEqual([
      "r2_foreign",
    ]);
  });

  it("flags a live id the row disagrees with", () => {
    expect(only({ type: "d1", id: D1 }, { ...E, rowD1Id: "old" })).toEqual([
      "d1_row",
    ]);
    expect(
      only({ type: "kv_namespace", namespace_id: KV }, { ...E, rowKvId: "o" }),
    ).toEqual(["kv_row"]);
  });

  it("a row with no id yet isn't a problem", () => {
    expect(only({ type: "d1", id: D1 }, { ...E, rowD1Id: null })).toEqual([]);
  });

  it("flags a missing id and a name that doesn't resolve", () => {
    expect(only({ type: "d1" })).toEqual(["d1_unreported"]);
    expect(only({ type: "kv_namespace" })).toEqual(["kv_unreported"]);
    expect(only({ type: "d1", id: D1 }, { ...E, d1Id: null })).toEqual([
      "d1_unresolved",
    ]);
  });

  it("ratelimit namespaces stay inside this install's stride", () => {
    const rl = (namespace_id: unknown) =>
      only({ type: "ratelimit", namespace_id });
    expect(rl("1000008")).toEqual([]);
    expect(rl("1000015")).toEqual([]);
    expect(rl(1000015)).toEqual([]);
    expect(rl("1000016")).toEqual(["ratelimit_foreign"]);
    expect(rl("1000007")).toEqual(["ratelimit_foreign"]);
    expect(rl("nope")).toEqual(["ratelimit_foreign"]);
    expect(rl(undefined)).toEqual(["ratelimit_unreported"]);
  });

  it("flags a Durable Object of another class or another script", () => {
    const d = (o: Record<string, unknown>) =>
      only({ type: "durable_object_namespace", ...o });
    expect(d({ class_name: "ArtifactRuntime" })).toEqual([]);
    expect(d({ class_name: "ArtifactRuntime", script_name: SCRIPT })).toEqual(
      [],
    );
    expect(d({ class_name: "Other" })).toEqual(["do_class"]);
    expect(
      d({ class_name: "ArtifactRuntime", script_name: "oa-s-xyz" }),
    ).toEqual(["do_foreign_script"]);
  });

  it("reports a binding type it doesn't know", () => {
    expect(only({ type: "queue" })).toEqual(["unknown_type_queue"]);
  });

  it("names the binding and a code, never an id", () => {
    const text = JSON.stringify(
      bindingIdProblems([{ type: "d1", name: "DB", id: "secret-id" }], E),
    );
    expect(text).toContain("DB");
    expect(text).not.toContain("secret-id");
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
