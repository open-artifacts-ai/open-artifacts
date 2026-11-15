// #2543: the one-line check llms.txt gives an agent really passes the pinned
// bytes and stops on any other. Runs the rendered command in a shell.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { busInstallBlock } from "../../src/mcp/bus-install.ts";

describe("the pin check in llms.txt", () => {
  it("passes the pinned bytes and prints MISMATCH for any other", () => {
    const dir = mkdtempSync(join(tmpdir(), "oa-pin-"));
    const bytes = Buffer.from("not a real tarball");
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    const txt = busInstallBlock("https://artifacts.example.com", {
      version: "1.2.3",
      integrity,
    });
    const cmd = /^(node -e '.*')$/m.exec(txt)?.[1] ?? "";
    expect(cmd).not.toBe("");
    const run = () =>
      spawnSync("sh", ["-c", cmd], { cwd: dir, encoding: "utf8" });
    const file = join(dir, "open-artifacts-bus-1.2.3.tgz");
    writeFileSync(file, bytes);
    expect(run().status).toBe(0);
    writeFileSync(file, "tampered");
    const bad = run();
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("MISMATCH");
  });
});
