import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sandbox, script } from "./stubs.ts";

// deploy-token-expiry.sh: the deploy token's end date, read back; an issue
// naming only the secret 30 days ahead, once. The clock is pinned.
const SCRIPT = script("deploy-token-expiry.sh");
const TOK = "cfut_DEPLOY_token_never_printed_0123";
const NOW = Date.parse("2026-10-31T12:00:00Z") / 1000;
const REPO = "open-artifacts-ai/open-artifacts";

const curl = `cfg="$(cat)"
case "$cfg" in *"$TOK_EXPECT"*) ;; *) echo '{"success":false,"errors":[{"code":1000}]}'; exit 0 ;; esac
cat "$STATE/verify.json"`;
const gh = `
case "$1 $2" in
  "issue list") cat "$STATE/issues.json" ;;
  "issue create") for ((i = 1; i <= $#; i++)); do [ "\${!i}" = --body ] && { j=$((i + 1)); printf '%s' "\${!j}" > "$STATE/body"; }; done; exit 0 ;;
  *) exit 1 ;;
esac`;
const verify = (result: Record<string, unknown>) =>
  JSON.stringify({ success: true, errors: [], result });
const run = (
  result: Record<string, unknown> | string,
  issues: unknown[] = [],
  env = "staging",
) => {
  const sb = sandbox({ curl, gh });
  writeFileSync(
    join(sb.dir, "verify.json"),
    typeof result === "string" ? result : verify(result),
  );
  writeFileSync(join(sb.dir, "issues.json"), JSON.stringify(issues));
  const r = sb.run(["bash", SCRIPT, env], {
    env: {
      STATE: sb.dir,
      CLOUDFLARE_API_TOKEN: TOK,
      TOK_EXPECT: TOK,
      GH_TOKEN: "gh",
      GITHUB_REPOSITORY: REPO,
      TOKEN_NOW: String(NOW),
    },
  });
  const log = sb.log();
  expect([r.out, r.err, ...log].join("\n")).not.toContain(TOK);
  const f = join(sb.dir, "body");
  const body = existsSync(f) ? readFileSync(f, "utf8") : "";
  return {
    ...r,
    log,
    body,
    creates: log.filter((l) => l.startsWith("gh issue create")),
  };
};

describe("deploy-token-expiry.sh", () => {
  it("more than 30 days left: says when, opens nothing", () => {
    const r = run({ status: "active", expires_on: "2027-10-01T00:00:00Z" });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(
      "CLOUDFLARE_API_TOKEN (hosted-staging-deploy) ends 2027-10-01",
    );
    expect(r.log.filter((l) => l.startsWith("gh "))).toEqual([]);
  });
  it("30 days or less: opens one issue naming only the secret and its Environment", () => {
    const r = run({ status: "active", expires_on: "2026-11-20T00:00:00.000Z" });
    expect(r.code, r.err).toBe(0);
    expect(r.creates).toHaveLength(1);
    expect(r.creates[0]).toContain(
      "--title Roll CLOUDFLARE_API_TOKEN in hosted-staging-deploy: it ends 2026-11-20",
    );
    expect(r.body).toContain("`CLOUDFLARE_API_TOKEN`");
    expect(r.body).toContain("`hosted-staging-deploy`");
    expect(r.body).not.toMatch(/token id|[0-9a-f]{32}/i);
    expect(r.out).toContain("::warning::");
    // Exactly the 30th day still opens one.
    const edge = run({ status: "active", expires_on: "2026-11-30T12:00:00Z" });
    expect(edge.creates).toHaveLength(1);
  });
  it("an open issue for this Environment is not opened again; another env's is not this one", () => {
    const soon = { status: "active", expires_on: "2026-11-20T00:00:00Z" };
    const mine = run(soon, [
      {
        number: 12,
        title:
          "Roll CLOUDFLARE_API_TOKEN in hosted-staging-deploy: it ends 2026-11-20",
      },
    ]);
    expect(mine.code).toBe(0);
    expect(mine.creates).toEqual([]);
    expect(mine.out).toContain("issue #12 is already open");
    const other = run(soon, [
      {
        number: 13,
        title:
          "Roll CLOUDFLARE_API_TOKEN in hosted-prod-deploy: it ends 2026-11-20",
      },
    ]);
    expect(other.creates).toHaveLength(1);
  });
  it("prod names hosted-prod-deploy", () => {
    const r = run(
      { status: "active", expires_on: "2026-11-20T00:00:00Z" },
      [],
      "prod",
    );
    expect(r.creates[0]).toContain(
      "Roll CLOUDFLARE_API_TOKEN in hosted-prod-deploy",
    );
  });
  it("no end date warns; a token not active or a failed verify fails", () => {
    const none = run({ status: "active" });
    expect(none.code).toBe(0);
    expect(none.out).toContain(
      "::warning::CLOUDFLARE_API_TOKEN (hosted-staging-deploy) has no end date",
    );
    expect(
      run({ status: "expired", expires_on: "2026-10-01T00:00:00Z" }).code,
    ).toBe(1);
    expect(
      run(JSON.stringify({ success: false, errors: [{ code: 1000 }] })).code,
    ).toBe(1);
    expect(run({ status: "active", expires_on: "soon" }).code).toBe(1);
  });
  it("refuses a bad env", () => {
    expect(run({ status: "active" }, [], "dev").code).toBe(2);
  });
});
