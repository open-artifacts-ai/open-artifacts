import { expect, it } from "vitest";
import { attest } from "../src/attest.ts";

it("refuses an openclaw hello until the daemon admits the kind (#1693)", () => {
  const r = attest({
    kind: "openclaw",
    pid: process.pid,
    attest: { proc_start: "1" },
  } as unknown as Parameters<typeof attest>[0]);
  expect(r.ok).toBe(false);
});
