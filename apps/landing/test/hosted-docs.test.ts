import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dist = (p: string) =>
  readFileSync(fileURLToPath(new URL(`../dist/${p}`, import.meta.url)), "utf8");

// The hosted docs say the beta is free (OA Product's wording), on the page and
// in the one-file copy for agents (llms-full.txt), which is built from it.
describe("hosted docs", () => {
  it("say the beta is invite-only and free, and that stopping costs nothing now", () => {
    const full = dist("llms-full.txt");
    for (const s of [
      "get an instance at your own address. It's invite-only and free during the private beta; we'll email you before paid plans start.",
      "**2. Stop paying.** Nothing to do during the beta: there's no charge. Once paid plans start, open Settings, then Plan and billing, then Manage billing, and cancel. When your subscription ends, the instance becomes read-only: you can still read everything, and nothing is deleted.",
    ])
      expect(full).toContain(s);
    expect(full).not.toMatch(/free month|\$1\/month/);
  });
});
