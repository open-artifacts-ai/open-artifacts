import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { script } from "./stubs.ts";

const MARK = "-- oa:non-additive";

/**
 * A throwaway repo laid out like this one (scripts/ci/prod-migration-guard.sh
 * copied in, so it resolves `root` there), with stub wrangler and verifier.
 */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "guard-"));
  const git = (...a: string[]) =>
    execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  mkdirSync(join(dir, "scripts/ci"), { recursive: true });
  mkdirSync(join(dir, "apps/server/migrations"), { recursive: true });
  mkdirSync(join(dir, "apps/server/scripts"), { recursive: true });
  copyFileSync(
    script("prod-migration-guard.sh"),
    join(dir, "scripts/ci/prod-migration-guard.sh"),
  );
  const write = (p: string, s: string) => writeFileSync(join(dir, p), s);
  write("apps/server/migrations/0001_init.sql", "create table a (x);\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  git("tag", "v1.0.0");
  const release = (tag: string, files: Record<string, string>) => {
    for (const [p, s] of Object.entries(files)) write(p, s);
    git("add", "-A");
    git("commit", "-qm", tag);
    git("tag", tag);
  };
  // Stubs: wrangler logs its argv and answers deployments/time-travel; the
  // verifier logs too, writes captures, and fails verify when VERIFY_FAIL=1.
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  writeFileSync(
    join(bin, "wrangler"),
    `#!/usr/bin/env bash
echo "wrangler $*" >> "${log}"
case "$1 $2" in
  "deployments list") echo '[{"versions":[{"version_id":"old-1","percentage":100}]},{"versions":[{"version_id":"live-2","percentage":100}]}]' ;;
  "d1 time-travel") [ "$3" = info ] && echo '{"bookmark":"bm-123"}' ;;
  "d1 info") echo '{"database_size":'"\${DB_SIZE:-1000}"'}' ;;
esac
exit 0
`,
  );
  chmodSync(join(bin, "wrangler"), 0o755);
  write(
    "apps/server/scripts/verify-migration.ts",
    `import { appendFileSync, writeFileSync } from "node:fs";
const [cmd, , db, , file] = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, \`verifier \${cmd} \${db}\\n\`);
if (cmd === "capture") writeFileSync(file, process.env.CAPTURE ?? "counts-v1");
if (cmd === "verify" && process.env.VERIFY_FAIL === "1") process.exit(1);
`,
  );
  const run = (mode: string, env: Record<string, string> = {}) => {
    const out = join(dir, "out");
    const summary = join(dir, "summary");
    writeFileSync(out, "");
    writeFileSync(summary, "");
    writeFileSync(log, "");
    const r = spawnSync(
      "bash",
      [join(dir, "scripts/ci/prod-migration-guard.sh"), mode],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          WRANGLER: join(bin, "wrangler"),
          GITHUB_OUTPUT: out,
          GITHUB_STEP_SUMMARY: summary,
          GUARD_DIR: join(dir, "guard"),
          PROD_NAME: "open-artifacts-prod",
          ...env,
        },
      },
    );
    return {
      code: r.status,
      stdout: r.stdout,
      stderr: r.stderr,
      out: readFileSync(out, "utf8"),
      summary: readFileSync(summary, "utf8"),
      calls: readFileSync(log, "utf8").split("\n").filter(Boolean),
    };
  };
  return { dir, release, run };
}

describe("prod-migration-guard.sh detect", () => {
  it("an additive release deploys as usual", () => {
    const r = repo();
    r.release("v1.1.0", {
      "apps/server/migrations/0002_add.sql": "alter table a add y;\n",
    });
    const d = r.run("detect", {
      TAG: "v1.1.0",
      EVENT: "push",
      PROD_VERSION: "1.0.0",
    });
    expect(d.code).toBe(0);
    expect(d.out).toBe("hold=false\nguarded=false\n");
  });
  it("a non-additive migration holds the automatic deploy, and a manual run deploys it guarded", () => {
    const r = repo();
    r.release("v1.1.0", {
      "apps/server/migrations/0002_rebuild.sql": `${MARK}\ncreate table a2 (x);\n`,
    });
    const auto = r.run("detect", {
      TAG: "v1.1.0",
      EVENT: "push",
      PROD_VERSION: "1.0.0",
    });
    expect(auto.code).toBe(0);
    expect(auto.out).toBe("hold=true\nguarded=false\n");
    expect(auto.stdout).toContain("::warning title=Prod deploy held::");
    expect(auto.summary).toContain("0002_rebuild.sql");
    const manual = r.run("detect", {
      TAG: "v1.1.0",
      EVENT: "workflow_dispatch",
      PROD_VERSION: "1.0.0",
    });
    expect(manual.out).toBe("hold=false\nguarded=true\n");
  });
  it("only migrations added since the version prod runs count; the marker must be the first line", () => {
    const r = repo();
    r.release("v1.1.0", {
      "apps/server/migrations/0002_rebuild.sql": `${MARK}\n`,
    });
    r.release("v1.2.0", {
      "apps/server/migrations/0003_add.sql": `alter table a add z;\n${MARK}\n`,
    });
    // Prod already took 0002 (it runs 1.1.0): 1.2.0 adds nothing non-additive.
    expect(
      r.run("detect", { TAG: "v1.2.0", EVENT: "push", PROD_VERSION: "1.1.0" })
        .out,
    ).toBe("hold=false\nguarded=false\n");
  });
  it("a held release's migration still holds the next release (prod on 0.71.0, tag 0.73.0)", () => {
    const r = repo();
    r.release("v0.71.0", {
      "apps/server/migrations/0016_add.sql": "alter table a add y;\n",
    });
    // 0.72.0 adds 0017 and is held, so prod stays on 0.71.0.
    r.release("v0.72.0", {
      "apps/server/migrations/0017_image_format.sql": `${MARK}\ncreate table a2 (x);\n`,
    });
    r.release("v0.73.0", {
      "apps/server/migrations/0018_trash_index.sql":
        "create index i on a (y);\n",
    });
    const d = r.run("detect", {
      TAG: "v0.73.0",
      EVENT: "push",
      PROD_VERSION: "0.71.0",
    });
    expect(d.out).toBe("hold=true\nguarded=false\n");
    expect(d.summary).toContain("0017_image_format.sql");
    // Its guarded dispatch deploys it guarded.
    expect(
      r.run("detect", {
        TAG: "v0.73.0",
        EVENT: "workflow_dispatch",
        PROD_VERSION: "0.71.0",
      }).out,
    ).toBe("hold=false\nguarded=true\n");
  });
  describe("an already-deployed migration changes", () => {
    const detect = (r: ReturnType<typeof repo>, event = "push") =>
      r.run("detect", { TAG: "v1.1.0", EVENT: event, PROD_VERSION: "1.0.0" });
    const held = (d: ReturnType<ReturnType<typeof repo>["run"]>) => {
      expect(d.out).toBe("hold=true\nguarded=false\n");
      expect(d.summary).toContain("0001_init.sql");
    };
    it("a modified migration holds, even for a manual run", () => {
      const r = repo();
      r.release("v1.1.0", {
        "apps/server/migrations/0001_init.sql": "create table a (x, y);\n",
      });
      held(detect(r));
      held(detect(r, "workflow_dispatch"));
    });
    it("a deleted migration holds", () => {
      const r = repo();
      execFileSync(
        "git",
        ["rm", "-q", "apps/server/migrations/0001_init.sql"],
        {
          cwd: r.dir,
        },
      );
      r.release("v1.1.0", {});
      held(detect(r));
    });
    it("a renamed migration holds", () => {
      const r = repo();
      execFileSync(
        "git",
        [
          "mv",
          "apps/server/migrations/0001_init.sql",
          "apps/server/migrations/0001_renamed.sql",
        ],
        { cwd: r.dir },
      );
      r.release("v1.1.0", {});
      const d = detect(r);
      expect(d.out).toBe("hold=true\nguarded=false\n");
      expect(d.summary).toContain("0001_renamed.sql");
    });
    it("an added additive migration alone does not hold", () => {
      const r = repo();
      r.release("v1.1.0", {
        "apps/server/migrations/0002_add.sql": "alter table a add y;\n",
      });
      expect(detect(r).out).toBe("hold=false\nguarded=false\n");
    });
  });
  it("any doubt holds: prod's version unknown, not a release, or without a tag; an unknown tag", () => {
    const r = repo();
    r.release("v1.1.0", {
      "apps/server/migrations/0002_add.sql": "alter table a add y;\n",
    });
    for (const PROD_VERSION of ["", "1.0", "1.0.0-rc.1", "9.9.9", "<html>"]) {
      const d = r.run("detect", { TAG: "v1.1.0", EVENT: "push", PROD_VERSION });
      expect(d.out, PROD_VERSION).toBe("hold=true\nguarded=false\n");
    }
    expect(
      r.run("detect", { TAG: "v9.9.9", EVENT: "push", PROD_VERSION: "1.0.0" })
        .out,
    ).toBe("hold=true\nguarded=false\n");
  });
});

describe("prod-migration-guard.sh record, verify, restore", () => {
  it("record: the live (last) Worker version, a bookmark, and a capture", () => {
    const r = repo();
    const d = r.run("record");
    expect(d.code).toBe(0);
    expect(d.out).toBe("worker_version=live-2\nbookmark=bm-123\n");
    expect(d.calls).toEqual([
      "wrangler d1 info open-artifacts-prod --json",
      "wrangler deployments list --name open-artifacts-prod --json",
      "wrangler d1 time-travel info open-artifacts-prod --json",
      "verifier capture open-artifacts-prod",
    ]);
    expect(d.summary).toContain("`bm-123`");
  });
  it("record refuses when a rebuild could double the database past its limit", () => {
    const r = repo();
    const ok = r.run("record", { DB_SIZE: "5000", D1_LIMIT_BYTES: "10000" });
    expect(ok.code).toBe(0);
    const big = r.run("record", { DB_SIZE: "5001", D1_LIMIT_BYTES: "10000" });
    expect(big.code).toBe(1);
    expect(big.stderr).toContain("not migrating");
    // Nothing recorded, nothing captured.
    expect(big.out).toBe("");
    expect(big.calls).toEqual(["wrangler d1 info open-artifacts-prod --json"]);
  });
  it("verify: the migration's verifier decides; missing verifier refuses", () => {
    const r = repo();
    r.run("record");
    expect(r.run("verify").code).toBe(0);
    expect(r.run("verify", { VERIFY_FAIL: "1" }).code).not.toBe(0);
    const gone = r.run("verify", {
      VERIFY_SCRIPT: "apps/server/scripts/nope.ts",
    });
    expect(gone.code).toBe(1);
    expect(gone.stderr).toContain("refusing a guarded deploy without it");
  });
  it("restore: Worker first, then D1 to the bookmark, then compare with the capture", () => {
    const r = repo();
    r.run("record");
    const env = { WORKER_VERSION: "live-2", BOOKMARK: "bm-123" };
    const ok = r.run("restore", env);
    expect(ok.code).toBe(0);
    expect(ok.calls).toEqual([
      "wrangler rollback live-2 --name open-artifacts-prod --message non-additive migration failed verification --yes",
      "wrangler d1 time-travel restore open-artifacts-prod --bookmark bm-123 --json",
      "verifier capture open-artifacts-prod",
    ]);
    expect(ok.summary).toContain("matches its pre-migration capture");
    expect(ok.summary).toContain(
      "discards every write made to open-artifacts-prod since bookmark",
    );
    // The restored database differs from the capture: fail loudly.
    const bad = r.run("restore", { ...env, CAPTURE: "counts-v2" });
    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain("differs from its pre-migration capture");
  });
});
