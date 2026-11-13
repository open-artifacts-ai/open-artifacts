import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #2304: count fchmod calls made through file handles.
const calls = vi.hoisted(() => ({ chmod: 0 }));
vi.mock("node:fs/promises", async (orig) => {
  const real = await orig<typeof import("node:fs/promises")>();
  return {
    ...real,
    open: async (...a: Parameters<typeof real.open>) => {
      const fh = await real.open(...a);
      const chmod = fh.chmod.bind(fh);
      fh.chmod = async (m) => {
        calls.chmod++;
        return chmod(m);
      };
      return fh;
    },
  };
});

import { createEventLog } from "../src/index.ts";

let d: string;
beforeEach(() => {
  d = mkdtempSync(join(tmpdir(), "oa-evlog-chmod-"));
  calls.chmod = 0;
});
afterEach(() => rmSync(d, { recursive: true, force: true }));

describe("event log mode (#2304)", () => {
  it("fchmods only when the mode is wrong", async () => {
    const f = join(d, "logs", "events.log");
    const log = createEventLog(f);
    log("e");
    await log.flush();
    const first = calls.chmod;
    expect(statSync(f).mode & 0o777).toBe(0o600);
    // Already right: later writes make no fchmod call.
    log("e");
    log("e");
    await log.flush();
    expect(calls.chmod).toBe(first);
    // Wrong: fixed again.
    chmodSync(f, 0o644);
    log("e");
    await log.flush();
    expect(calls.chmod).toBeGreaterThan(first);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    // A wrong folder mode is fixed too.
    chmodSync(join(d, "logs"), 0o755);
    log("e");
    await log.flush();
    expect(statSync(join(d, "logs")).mode & 0o777).toBe(0o700);
  });
});
