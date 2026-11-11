import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readQueue } from "../src/codex-queue-store.ts";
import { queueDb } from "./codex-queue-fixture.ts";

const THREAD = "019a0000-0000-7000-8000-000000000001";
const home = () => mkdtempSync(join(tmpdir(), "ob-cq-"));

describe("codex queue store reader (codex-cli 0.166 schema)", () => {
  it("finds an item of the thread whose text starts with the head and a blank line", () => {
    const h = home();
    queueDb(h, {
      rows: [{ thread: THREAD, text: "[oa-bus] a\n\nbody" }],
      revision: { [THREAD]: 3 },
    });
    expect(readQueue(h, THREAD, "[oa-bus] a")).toEqual({
      present: true,
      revision: 3,
    });
  });

  it("absent: other thread, other head, a head only quoted in a body, malformed payloads skipped", () => {
    const h = home();
    queueDb(h, {
      rows: [
        { thread: "other", text: "[oa-bus] a\n\nbody" },
        { thread: THREAD, text: "[oa-bus] b\n\nbody" },
        { thread: THREAD, text: "x\n\n[oa-bus] a\n\n" },
        { thread: THREAD, raw: "{ not json" },
      ],
    });
    expect(readQueue(h, THREAD, "[oa-bus] a")).toEqual({
      present: false,
      revision: null,
    });
  });

  it("unknown, never absent: no file, no table, a changed shape", () => {
    expect(readQueue(home(), THREAD, "h")).toBeUndefined();
    const h = home();
    queueDb(h, { noItemsTable: true });
    expect(readQueue(h, THREAD, "h")).toBeUndefined();
    const g = home();
    queueDb(g, { rows: [{ thread: THREAD, raw: "42" }], badRevision: true });
    expect(readQueue(g, THREAD, "h")).toBeUndefined();
  });
});
