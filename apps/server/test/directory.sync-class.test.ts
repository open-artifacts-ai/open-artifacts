// P3 Task 13a: the DirectorySync DO class ships inert, one release before
// anything calls it (the P1 rule). Every RPC answers the "never" status.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { SyncStatusSchema } from "@oa/shared";
import { describe, expect, it } from "vitest";
import type { DirectorySync } from "../src/directory/sync-do.js";

const stub = () => {
  const ns = env.DIRECTORY_SYNC;
  if (!ns) throw new Error("DIRECTORY_SYNC unbound");
  return ns.get(
    ns.idFromName("install"),
  ) as unknown as DurableObjectStub<DirectorySync>;
};

describe("DirectorySync (inert class)", () => {
  it("status, kick and confirmHeld answer the never SyncStatus", async () => {
    const s = stub();
    for (const st of [
      await s.status(),
      await s.kick("cron"),
      await s.confirmHeld("g-1"),
    ]) {
      expect(SyncStatusSchema.parse(st)).toMatchObject({
        state: "never",
        binding: null,
        held: [],
        lastSuccessAt: null,
      });
    }
  });

  it("enqueue is a no-op and stores nothing; no alarm is set", async () => {
    const s = stub();
    await s.enqueue({ kind: "noop" });
    const r = await runInDurableObject(s, async (_o, state) => ({
      tables: state.storage.sql
        .exec(
          "select name from sqlite_master where type = 'table' and name not like '\\_%' escape '\\'",
        )
        .toArray(),
      alarm: await state.storage.getAlarm(),
    }));
    expect(r).toEqual({ tables: [], alarm: null });
  });
});
