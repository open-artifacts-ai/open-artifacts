import { ALERT_CONDITIONS } from "@oa/shared/provisioning";
import { describe, expect, it } from "vitest";
import { platformDb } from "../../../packages/provision/test/platform-db.ts";
import { MAX_REPORT_BYTES } from "../src/prodclean.ts";
import {
  BEARER,
  MONITOR,
  makeDb,
  makeEnv,
  NOW,
  REDLINE,
  REPO,
  req,
  sqliteD1,
  VARS,
  worker,
} from "./support.ts";

const post = (body: string, type = "application/json") =>
  req(
    "/prodclean",
    { method: "POST", body, headers: { "content-type": type } },
    BEARER,
  );

async function send(
  body: string,
  o: { ref?: string; type?: string; env?: object } = {},
) {
  const d = makeDb();
  const { w } = worker(o.ref ?? MONITOR);
  const res = await w.fetch(
    post(body, o.type),
    makeEnv({ PLATFORM_DB: d.db, ...o.env }),
  );
  return { res, runs: d.runs };
}

const FAIL = JSON.stringify({
  ok: false,
  code: "install_dirty",
  installId: "iabcdefghijk",
  detail: "prodClean iabcdefghijk: script lists TEST_HOOK_KEY",
});

describe("POST /prodclean", () => {
  it("a valid report writes exactly one row at the pinned clock -> 204", async () => {
    const { res, runs } = await send(FAIL);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(runs).toEqual([
      {
        sql: "INSERT INTO prodclean_reports (at, ok, code, install_id, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
        values: [
          NOW,
          0,
          "install_dirty",
          "iabcdefghijk",
          "prodClean iabcdefghijk: script lists TEST_HOOK_KEY",
        ],
      },
    ]);
    const pass = await send(JSON.stringify({ ok: true, code: "pass" }), {
      type: "application/json; charset=utf-8",
    });
    expect(pass.res.status).toBe(204);
    expect(pass.runs[0]?.values).toEqual([NOW, 1, "pass", null, null]);
  });

  it("red-line's ref (pinned, not the monitor's) -> 403, nothing written", async () => {
    const { res, runs } = await send(FAIL, { ref: REDLINE });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('{"error":"forbidden"}');
    expect(runs).toEqual([]);
  });

  it("the monitor's ref, when the pins don't list it -> 403", async () => {
    // verify is injected, so it can hand back a ref the pins omit.
    const { res, runs } = await send(FAIL, {
      env: { OIDC_JOB_WORKFLOW_REFS: REDLINE },
    });
    expect(res.status).toBe(403);
    expect(runs).toEqual([]);
  });

  it("the monitor path is parsed from the listed ref, never rebuilt from OIDC_REPOSITORY", async () => {
    // The verifier pins the repository; this route only parses the ref.
    const { res, runs } = await send(FAIL, {
      env: { OIDC_REPOSITORY: "renamed-org/renamed-repo" },
    });
    expect(res.status).toBe(204);
    expect(runs).toHaveLength(1);
  });

  it("an unlisted monitor ref (another repository) -> 403", async () => {
    const ref = `evil/repo/.github/workflows/prodclean-monitor.yml@refs/heads/main`;
    const { res, runs } = await send(FAIL, { ref });
    expect(res.status).toBe(403);
    expect(runs).toEqual([]);
  });

  it("a listed ref whose workflow path after owner/repo is not the monitor's on main -> 403", async () => {
    for (const ref of [
      MONITOR.replace("refs/heads/main", "refs/heads/dev"),
      `${REPO}/.github/workflows/prodclean-monitor.yml@refs/heads/main2`,
      `${REPO}/x/.github/workflows/prodclean-monitor.yml@refs/heads/main`,
      `${REPO}/.github/workflows/other/prodclean-monitor.yml@refs/heads/main`,
      `${REPO}.github/workflows/prodclean-monitor.yml@refs/heads/main`,
      `/${REPO}/.github/workflows/prodclean-monitor.yml@refs/heads/main`,
      `open-artifacts-ai//.github/workflows/prodclean-monitor.yml@refs/heads/main`,
      ".github/workflows/prodclean-monitor.yml@refs/heads/main",
    ]) {
      const { res, runs } = await send(FAIL, {
        ref,
        env: {
          OIDC_JOB_WORKFLOW_REFS: `${VARS.OIDC_JOB_WORKFLOW_REFS},${ref}`,
        },
      });
      expect(res.status, ref).toBe(403);
      expect(runs).toEqual([]);
    }
  });

  const bad: [string, string, string?][] = [
    ["an unknown key", JSON.stringify({ ok: true, code: "pass", extra: 1 })],
    ["a bad code", JSON.stringify({ ok: false, code: "Bad-Code" })],
    [
      "a code over 40",
      JSON.stringify({ ok: false, code: `a${"b".repeat(40)}` }),
    ],
    [
      "a detail over 200",
      JSON.stringify({ ok: false, code: "x", detail: "d".repeat(201) }),
    ],
    [
      "a bad install id",
      JSON.stringify({ ok: false, code: "x", installId: "nope" }),
    ],
    ["no ok", JSON.stringify({ code: "pass" })],
    ["not JSON", "ok=true"],
    ["an array", "[]"],
    ["empty", ""],
    ["text/plain", JSON.stringify({ ok: true, code: "pass" }), "text/plain"],
    [
      "over 4 KiB",
      JSON.stringify({
        ok: true,
        code: "pass",
        pad: "p".repeat(MAX_REPORT_BYTES),
      }),
    ],
  ];
  for (const [what, body, type] of bad)
    it(`${what} -> 400 with no echo, nothing written`, async () => {
      const { res, runs } = await send(body, { type });
      expect(res.status).toBe(400);
      expect(await res.text()).toBe('{"error":"bad_request"}');
      expect(runs).toEqual([]);
    });

  it("the stored rows feed C2's prodclean_failed alert: the latest one only", async () => {
    const sq = platformDb();
    const env = makeEnv({ PLATFORM_DB: sqliteD1(sq) });
    let t = NOW;
    const { w } = worker(MONITOR, () => t);
    const alert = () => sq.prepare(ALERT_CONDITIONS.prodclean_failed.sql).all();

    expect((await w.fetch(post(FAIL), env)).status).toBe(204);
    expect(alert()).toEqual([
      {
        install_id: null,
        job_id: null,
        job_kind: null,
        code: "install_dirty",
        message: null,
        since: NOW,
      },
    ]);
    t = NOW + 3_600_000;
    const pass = JSON.stringify({ ok: true, code: "pass" });
    expect((await w.fetch(post(pass), env)).status).toBe(204);
    expect(alert()).toEqual([]);
    // The detail is kept for the scheduler's email, never in the alert row.
    expect(
      sq
        .prepare(
          "SELECT ok, code, install_id, detail FROM prodclean_reports ORDER BY id",
        )
        .all(),
    ).toEqual([
      {
        ok: 0,
        code: "install_dirty",
        install_id: "iabcdefghijk",
        detail: "prodClean iabcdefghijk: script lists TEST_HOOK_KEY",
      },
      { ok: 1, code: "pass", install_id: null, detail: null },
    ]);
  });
});
