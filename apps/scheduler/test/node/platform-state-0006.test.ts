// Moved from packages/provisioning-contract/test/c5.test.ts: the contract is
// public, apps/platform-db is hosted, so the cross-check lives with the hosted
// side, here with the scheduler that writes platform_state (#1056).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLATFORM_STATE_0006_KEYS } from "@oa/provisioning-contract/state";
import { describe, expect, it } from "vitest";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("platform_state keys (5.8, 0006)", () => {
  it("PLATFORM_STATE_0006_KEYS is exactly the key list in 0006's comment", () => {
    const sql = readFileSync(
      join(repo, "apps/platform-db/migrations/0006_platform_state.sql"),
      "utf8",
    );
    const listed = [...sql.matchAll(/^--\s{3}(\S+)\s{2,}/gm)].map((m) => m[1]);
    expect(listed).toEqual([...PLATFORM_STATE_0006_KEYS]);
  });
});
