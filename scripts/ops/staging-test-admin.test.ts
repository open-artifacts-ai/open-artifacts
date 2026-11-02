import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  ADMIN_HOST,
  COOKIE,
  parseLog,
  storageState,
} from "./staging-test-admin.ts";

// #1053: the agent's side of the staging test admin session, and the
// workflow that mints it.

const root = join(import.meta.dirname, "../..");
const wf = readFileSync(
  join(root, ".github/workflows/staging-test-admin.yml"),
  "utf8",
);
// biome-ignore lint/suspicious/noExplicitAny: untyped workflow YAML
const w: any = parse(wf);

describe("staging-test-admin.yml", () => {
  const job = w.jobs.session;
  it("is dispatch only, main only, in the redline-staging Environment, with id-token on the job only", () => {
    expect(Object.keys(w.on)).toEqual(["workflow_dispatch"]);
    expect(w.permissions).toEqual({ contents: "read" });
    expect(job.environment).toBe("redline-staging");
    expect(job.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(job.steps[0].run).toContain('[ "$REF" = refs/heads/main ]');
  });

  it("reads no secret, checks out nothing, and prints only the sealed value and expiry", () => {
    expect(wf).not.toMatch(/\$\{\{\s*secrets\./);
    expect(wf).not.toContain("actions/checkout");
    const echoes = (job.steps[0].run as string)
      .split("\n")
      .filter((l) => /^\s*echo /.test(l) && !l.includes("exit 1"));
    expect(echoes).toEqual(
      [
        'echo "test-admin-sealed: $sealed"',
        'echo "test-admin-expires-at: $expires"',
      ].map((e) => expect.stringContaining(e)),
    );
    // The JWT reaches curl on stdin, never argv.
    expect(job.steps[0].run).toContain("curl -fsS -K -");
  });

  it("calls R28 on the staging api host with the provisioning audience", () => {
    expect(job.steps[0].env.AUDIENCE).toBe(
      "https://api.open-artifacts-staging.app",
    );
    expect(job.steps[0].run).toContain('"$AUDIENCE/v1/test-admin/session"');
  });
});

describe("the agent's side", () => {
  it("parses the sealed value and expiry from the run log", () => {
    const log =
      "session\tMint\t2026-11-02T06:00:00Z test-admin-sealed: oa-seal-v1.a.b.c\nsession\tMint\t2026-11-02T06:00:00Z test-admin-expires-at: 1793600000000\n";
    expect(parseLog(log)).toEqual({
      sealed: "oa-seal-v1.a.b.c",
      expiresAt: 1793600000000,
    });
    expect(parseLog("nothing here")).toBeNull();
  });

  it("the storage state holds one Secure, HttpOnly, Strict cookie for the staging admin host", () => {
    const s = storageState("sid123", 1793600000000);
    expect(s).toEqual({
      cookies: [
        {
          name: COOKIE,
          value: "sid123",
          domain: ADMIN_HOST,
          path: "/",
          expires: 1793600000,
          httpOnly: true,
          secure: true,
          sameSite: "Strict",
        },
      ],
      origins: [],
    });
    expect(ADMIN_HOST).toBe("admin.open-artifacts-staging.app");
  });
});
