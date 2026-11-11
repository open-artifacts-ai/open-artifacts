// #2095: doctor's old output style file line makes sense when claude is missing or too old.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { doctor } from "../src/commands/doctor.ts";
import { fakeCtx } from "./fake.ts";

const MARKER =
  "<!-- managed by the Open Artifacts bus installer: edits are replaced on reinstall. -->";

const run = async (claude: {
  code: number;
  stdout: string;
  stderr: string;
}) => {
  const ctx = fakeCtx({
    nodeVersion: "v22.11.0",
    which: (c) => c === "claude",
    exec: vi.fn(async () => claude),
  });
  const dir = join(ctx.userHome, ".claude/output-styles");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "artifacts-teammate.md"),
    `---\nname: Artifacts Teammate\n---\n${MARKER}\nbody\n`,
  );
  await doctor(ctx);
  return ctx.all().join("\n");
};

describe("doctor, older output style file (#2095)", () => {
  it("offers to replace it when Claude Code is new enough", async () => {
    const all = await run({
      code: 0,
      stdout: "2.1.322 (Claude Code)\n",
      stderr: "",
    });
    expect(all).toContain("also lists Artifacts Teammate");
    expect(all).toContain("to remove the old file");
  });

  it("says Claude Code is needed when it is too old or missing", async () => {
    for (const r of [
      { code: 0, stdout: "2.1.300 (Claude Code)\n", stderr: "" },
      { code: 1, stdout: "", stderr: "spawn claude ENOENT" },
    ]) {
      const all = await run(r);
      expect(all).toContain("is still in use");
      expect(all).toContain("2.1.319 or later");
      expect(all).not.toContain("to remove the old file");
    }
  });
});
