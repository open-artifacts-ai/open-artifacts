import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dist = (p: string) =>
  readFileSync(fileURLToPath(new URL(`../dist/${p}`, import.meta.url)), "utf8");

// The hosted docs say it is invite-only during the beta and keep the Solo
// trial and prices (OA Product's launch wording), on the page and in the
// one-file copy for agents (llms-full.txt), which is built from it.
describe("hosted docs", () => {
  it("say invite-only, the free month and the prices, and keep the original Stop paying step", () => {
    const full = dist("llms-full.txt");
    for (const s of [
      "get an instance at your own address. It's invite-only during the beta: after you sign up you're on the waitlist, and we email you when it's your turn. Solo starts with a free month, then $1/month or $10/year.",
      "**2. Stop paying.** Open Settings, then Plan and billing, then Manage billing, and cancel. When your subscription ends, the instance becomes read-only: you can still read everything, and nothing is deleted.",
    ])
      expect(full).toContain(s);
    expect(full).not.toContain("free during the private beta");
    expect(full).not.toContain("Nothing to do during the beta");
  });
});
