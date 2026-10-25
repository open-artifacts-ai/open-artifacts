// P3 T16: scripts/authz-probe.ts takes credentials only from its --creds
// file, and its exit code reports the comparison.
import { describe, expect, it } from "vitest";
import { main, SURFACES } from "../../scripts/authz-probe.ts";
import { SURFACES as FROM_TEST } from "../authz/surfaces.ts";

const u = "https://app.example.invalid";
/** A target that refuses everything (404). */
const nothing = async () =>
  new Response('{"error":{"code":"not_found","message":"Not found"}}', {
    status: 404,
  });
const runProbe = async (
  argv: string[],
  o: { env?: Record<string, string>; file?: unknown } = {},
) => {
  const lines: string[] = [];
  const code = await main(argv, o.env ?? {}, {
    log: (l) => lines.push(l),
    fetch: nothing,
    readFile: async () => JSON.stringify(o.file ?? {}),
  });
  return { code, out: lines.join("\n") };
};
const FILE = {
  callers: {
    anonymous: {},
    suspendedUser: { cookie: "c", token: "t", email: "s@example.invalid" },
  },
  artifacts: { personalPrivate: "AAAAAAAAAAAAAAAA" },
};

describe("authz-probe", () => {
  it("re-exports SURFACES", () => {
    expect(SURFACES).toBe(FROM_TEST);
  });
  it("authz-probe refuses credentials in argv", async () => {
    expect((await runProbe(["--base", u, "--pat", "x"])).code).toBe(2);
    expect((await runProbe(["--base", u, "--token", "x"])).code).toBe(2);
    expect((await runProbe(["--base", u, "--creds", "oa_pat_abc"])).code).toBe(
      2,
    );
    expect(
      (await runProbe(["--base", `${u}/?oa_session=x`, "--creds", "f"])).code,
    ).toBe(2);
  });
  it("refuses credentials in the environment", async () => {
    for (const env of [
      { OA_PAT: "x" } as Record<string, string>,
      { AUTHZ_PROBE_COOKIE: "x" },
      { SOMETHING: "oa_pat_abc" },
      // An MCP OAuth access token ({userId}:{grantId}:{secret}).
      { MCP: "AbCdEfGhJkLmNpQr:grant-1:s3cr3tvalue_xyz" },
    ]) {
      const r = await runProbe(["--base", u, "--creds", "f"], { env });
      expect(r.code).toBe(2);
      expect(r.out).not.toContain("oa_pat_abc");
    }
  });
  it("refuses any other flag, duplicates and missing values", async () => {
    for (const argv of [
      [],
      ["--base", u],
      ["--creds", "f"],
      ["--base", u, "--creds", "f", "--verbose"],
      ["--base", u, "--base", u, "--creds", "f"],
      ["--base", "--creds", "f"],
    ])
      expect((await runProbe(argv)).code, argv.join(" ")).toBe(2);
  });
  it("refuses unknown caller or artifact names", async () => {
    const r = await runProbe(["--base", u, "--creds", "f"], {
      file: { callers: { root: {} }, artifacts: {} },
    });
    expect(r.code).toBe(2);
  });
  it("exit 0 when every answer matches, 1 on a mismatch", async () => {
    // A private artifact nobody here may reach: all deny.
    const ok = await runProbe(["--", "--base", u, "--creds", "f"], {
      file: FILE,
    });
    expect(ok.out).toMatch(/ 0 mismatches$/);
    expect(ok.code).toBe(0);
    // otherMember reaches personalTeam (team): a refusing target mismatches.
    const r = await runProbe(["--base", u, "--creds", "f"], {
      file: {
        callers: { otherMember: { cookie: "c", token: "t" } },
        artifacts: { personalTeam: "AAAAAAAAAAAAAAAA" },
      },
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/MISMATCH rest get otherMember personalTeam/);
  });
  it("never runs a probe that writes", async () => {
    const methods = new Set<string>();
    await main(
      ["--base", u, "--creds", "f"],
      {},
      {
        log: () => {},
        fetch: async (req) => {
          methods.add(
            req.headers.get("x-oa-request") === null && req.method !== "GET"
              ? "csrf-probe"
              : req.method,
          );
          return nothing();
        },
        readFile: async () => JSON.stringify(FILE),
      },
    );
    // Writes only as CSRF probes (no X-OA-Request: refused before any
    // handler), or bodies that fail validation after the access check.
    expect([...methods].sort()).toEqual(
      ["GET", "POST", "PATCH", "PUT", "DELETE", "csrf-probe"].sort(),
    );
    expect(SURFACES.filter((s) => s.mutates).map((s) => s.name)).toEqual([
      "rest uploads",
      "rest visibility",
      "mcp restore_version",
      "mcp unshare_artifact",
      "mcp set_visibility",
      "mcp delete_artifact",
      "mcp artifact_data_set",
      "mcp artifact_data_update",
      "mcp artifact_data_delete",
      "mcp create_upload",
    ]);
  });
});
