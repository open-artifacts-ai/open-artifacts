// P3 T13 DirectorySync CPU (Free plan: 10 ms per DO alarm). One alarm reads
// one Google page; its Worker-side work is the parse, the binding plan and a
// group's member diff. Wall-clock budgets run serially via
// vitest.cpu.config.ts (median of 7); absolute bounds are reports, asserted
// only under test:cpu:strict (see budget()).
import { describe, expect, it } from "vitest";
import { planPage } from "../src/directory/binding.js";
import { parseUsersPage } from "../src/directory/google.js";
import { memberDiff } from "../src/directory/sync.js";
import { budget, medianMs as time } from "./cpu-time.js";

/** A 500-user users.list body, as Google sends it (fields= trimmed). */
const body = JSON.stringify({
  users: Array.from({ length: 500 }, (_, i) => ({
    id: String(100000000000000000000n + BigInt(i)),
    primaryEmail: `user${i}@example.com`,
    suspended: i % 50 === 0,
    isAdmin: false,
    customerId: "C0123",
  })),
  nextPageToken: "next",
});

describe("DirectorySync CPU (Free: 10 ms per alarm)", () => {
  it("500-user page parse + diff under 10 ms CPU", async ({ annotate }) => {
    const domains = new Set(["example.com"]);
    // The group's stored rows: 500 users, of whom 25 left and 25 joined.
    const cur = new Set(Array.from({ length: 500 }, (_, i) => `u${i}`));
    const seen = new Set(Array.from({ length: 500 }, (_, i) => `u${i + 25}`));
    let out = { added: 0, removed: 0, create: 0 };
    const ms = await time(async () => {
      const page = parseUsersPage(JSON.parse(body));
      const plan = planPage(domains, page.users);
      const d = memberDiff(seen, cur);
      out = {
        added: d.added.length,
        removed: d.removed.length,
        create: plan.create.length,
      };
    });
    expect(out).toEqual({ added: 25, removed: 25, create: 490 });
    await budget(annotate, "500-user page parse + diff", ms, 10);
    expect(ms).toBeLessThan(100);
  });
});
