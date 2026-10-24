import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { root, sandbox } from "../ci/stubs.ts";

// T3b R-N2 and fix round 5: the key ceremony uploads an env's signing key
// only when its GitHub Environment allows deployments from main only (the
// real control against a dispatch from another ref), has a required
// reviewer and no admin bypass, and a ruleset limits v* tags to the release
// App (no update, no delete).
const SCRIPT = join(root, "scripts/ops/hosted-set-signing-key.sh");
const KEY =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIfake0000000000000000000000000000000000\n-----END PRIVATE KEY-----\n";

// gh stub: answers the environment reads from $ENV_JSON / $POL_JSON and the
// ruleset reads from $RULESETS_JSON / $RULESET_<id>; a `secret set` stores
// its stdin in $SECRET_OUT.
const gh = `
case "$*" in
  "repo view --json nameWithOwner -q .nameWithOwner") echo "o/r";;
  "api repos/o/r/environments/"*"/deployment-branch-policies") printf '%s' "$POL_JSON";;
  "api repos/o/r/environments/"*) printf '%s' "$ENV_JSON";;
  "api repos/o/r/rulesets?includes_parents=true") printf '%s' "$RULESETS_JSON";;
  "api repos/o/r/rulesets/"*) last="\${@: -1}"; id="\${last##*/}"; v="RULESET_$id"; printf '%s' "\${!v}";;
  "secret set RELEASE_SIGNING_KEY "*) cat > "$SECRET_OUT";;
  *) echo "unexpected gh $*" >&2; exit 9;;
esac`;

const MAIN_ONLY = { protected_branches: false, custom_branch_policies: true };
const REVIEWER = [
  { type: "required_reviewers", reviewers: [{ type: "User" }] },
  { type: "branch_policy" },
];
const env = (
  p: unknown = MAIN_ONLY,
  rules: unknown[] = REVIEWER,
  extra: Record<string, unknown> = { can_admins_bypass: false },
) =>
  JSON.stringify({
    name: "hosted-staging",
    deployment_branch_policy: p,
    protection_rules: rules,
    ...extra,
  });
const pol = (b: { name: string; type?: string }[]) =>
  JSON.stringify({ total_count: b.length, branch_policies: b });
const GOOD_POL = pol([{ name: "main", type: "branch" }]);
// The release-please App's id (RELEASE_APP_ID), and the two v* tag rulesets:
// A blocks creation with only the App as bypass; B blocks update and deletion
// with no bypass at all, so not even the App can move or delete a release tag.
const APP = "424242";
const appBypass = {
  actor_id: Number(APP),
  actor_type: "Integration",
  bypass_mode: "always",
};
const tagRuleset = (o: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: 7,
    name: "release tags: creation",
    target: "tag",
    enforcement: "active",
    conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
    rules: [{ type: "creation" }],
    bypass_actors: [appBypass],
    ...o,
  });
const lockRuleset = (o: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: 8,
    name: "release tags: no update or delete",
    target: "tag",
    enforcement: "active",
    conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
    rules: [{ type: "update" }, { type: "deletion" }],
    bypass_actors: [],
    ...o,
  });
const RULESETS = JSON.stringify([
  { id: 3, name: "main", target: "branch", enforcement: "active" },
  {
    id: 7,
    name: "release tags: creation",
    target: "tag",
    enforcement: "active",
  },
  {
    id: 8,
    name: "release tags: no update or delete",
    target: "tag",
    enforcement: "active",
  },
]);

type Opts = {
  env?: string;
  envJson?: string;
  polJson?: string;
  input?: string;
  rulesets?: string;
  ruleset7?: string;
  ruleset8?: string;
  appId?: string | null;
};

function run(o: Opts = {}) {
  const sb = sandbox({ gh });
  const out = join(sb.dir, "secret");
  const r = spawnSync("bash", [SCRIPT, o.env ?? "staging"], {
    input: o.input ?? KEY,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(sb.dir, "bin")}:${process.env.PATH}`,
      STUB_LOG: join(sb.dir, "calls.log"),
      ENV_JSON: o.envJson ?? env(),
      POL_JSON: o.polJson ?? GOOD_POL,
      RULESETS_JSON: o.rulesets ?? RULESETS,
      RULESET_3: JSON.stringify({
        id: 3,
        target: "branch",
        enforcement: "active",
        rules: [],
      }),
      RULESET_7: o.ruleset7 ?? tagRuleset(),
      RULESET_8: o.ruleset8 ?? lockRuleset(),
      SECRET_OUT: out,
      ...(o.appId === null ? {} : { RELEASE_APP_ID: o.appId ?? APP }),
    },
  });
  const calls = sb.log();
  const secret = (() => {
    try {
      return readFileSync(out, "utf8");
    } catch {
      return null;
    }
  })();
  return { code: r.status, out: r.stdout, err: r.stderr, calls, secret };
}

describe("hosted-set-signing-key.sh", () => {
  it("uploads the key from stdin when every control holds", () => {
    const r = run();
    expect(r.code, r.err).toBe(0);
    expect(r.calls).toContain("gh api repos/o/r/environments/hosted-staging");
    expect(r.calls).toContain(
      "gh api repos/o/r/environments/hosted-staging/deployment-branch-policies",
    );
    expect(r.calls).toContain(
      "gh api repos/o/r/rulesets?includes_parents=true",
    );
    expect(r.calls).toContain("gh api repos/o/r/rulesets/7");
    expect(r.calls).toContain("gh api repos/o/r/rulesets/8");
    expect(r.calls).toContain(
      "gh secret set RELEASE_SIGNING_KEY --env hosted-staging --repo o/r",
    );
    expect(r.secret).toBe(KEY);
    // The key reaches gh on stdin only: never in an argv or the output.
    expect(r.calls.join("\n")).not.toContain("PRIVATE KEY");
    expect(r.out + r.err).not.toContain("PRIVATE KEY");
  });

  // User rulings 2026-10-24: neither env needs an approval step for now
  // (still main only, no admin bypass). A prod reviewer comes back before
  // FinQore go-live (docs/ops/hosted.md, first-create checklist).
  it.each(["staging", "prod"] as const)(
    "%s needs no required reviewer",
    (e) => {
      const r = run({
        env: e,
        envJson: env(MAIN_ONLY, [{ type: "branch_policy" }]),
      });
      expect(r.code, r.err).toBe(0);
      expect(r.calls).toContain(
        `gh secret set RELEASE_SIGNING_KEY --env hosted-${e} --repo o/r`,
      );
      expect(r.out).toContain("no approval step");
      expect(r.out).not.toMatch(/required reviewer/);
    },
  );

  it("checks the prod environment for prod", () => {
    const r = run({ env: "prod" });
    expect(r.code, r.err).toBe(0);
    expect(r.calls).toContain(
      "gh secret set RELEASE_SIGNING_KEY --env hosted-prod --repo o/r",
    );
  });

  it.each<[string, Opts]>([
    [
      "no deployment branch policy (every branch may deploy)",
      { envJson: env(null) },
    ],
    [
      "protected branches instead of a main-only list",
      {
        envJson: env({
          protected_branches: true,
          custom_branch_policies: false,
        }),
      },
    ],
    [
      "main plus another branch",
      {
        polJson: pol([
          { name: "main", type: "branch" },
          { name: "dev", type: "branch" },
        ]),
      },
    ],
    [
      "a wildcard branch pattern",
      { polJson: pol([{ name: "*", type: "branch" }]) },
    ],
    ["a tag named main", { polJson: pol([{ name: "main", type: "tag" }]) }],
    ["no policies at all", { polJson: pol([]) }],
    ["an environment read that is not JSON", { envJson: "not json" }],
    // Fix round 5 (1): admin bypass must be off.
    [
      "admins able to bypass the environment",
      { envJson: env(MAIN_ONLY, REVIEWER, { can_admins_bypass: true }) },
    ],
    ["no can_admins_bypass field", { envJson: env(MAIN_ONLY, REVIEWER, {}) }],
    // Fix round 5 (4): the v* tag ruleset.
    [
      "no tag ruleset at all",
      {
        rulesets: JSON.stringify([
          { id: 3, name: "main", target: "branch", enforcement: "active" },
        ]),
      },
    ],
    [
      "a tag ruleset that is not active",
      { ruleset7: tagRuleset({ enforcement: "evaluate" }) },
    ],
    [
      "a tag ruleset not on refs/tags/v*",
      {
        ruleset7: tagRuleset({
          conditions: {
            ref_name: { include: ["refs/tags/release-*"], exclude: [] },
          },
        }),
      },
    ],
    [
      "a tag ruleset that excludes some v* tags",
      {
        ruleset7: tagRuleset({
          conditions: {
            ref_name: { include: ["refs/tags/v*"], exclude: ["refs/tags/v9*"] },
          },
        }),
      },
    ],
    [
      "no creation rule in A",
      { ruleset7: tagRuleset({ rules: [{ type: "update" }] }) },
    ],
    [
      "a creation bypass for another app",
      {
        ruleset7: tagRuleset({
          bypass_actors: [{ ...appBypass, actor_id: 1 }],
        }),
      },
    ],
    [
      "a creation bypass for admins as well",
      {
        ruleset7: tagRuleset({
          bypass_actors: [
            appBypass,
            {
              actor_id: 5,
              actor_type: "RepositoryRole",
              bypass_mode: "always",
            },
          ],
        }),
      },
    ],
    [
      "no creation bypass at all (the app could not tag)",
      { ruleset7: tagRuleset({ bypass_actors: [] }) },
    ],
    // Manager (T3b, stricter): B blocks update and deletion with no bypass.
    [
      "no ruleset B (one combined ruleset with the App as bypass)",
      {
        rulesets: JSON.stringify([
          { id: 7, name: "release tags", target: "tag", enforcement: "active" },
        ]),
        ruleset7: tagRuleset({
          rules: [
            { type: "creation" },
            { type: "update" },
            { type: "deletion" },
          ],
        }),
      },
    ],
    [
      "B lets the App bypass update and deletion",
      { ruleset8: lockRuleset({ bypass_actors: [appBypass] }) },
    ],
    [
      "B lets admins bypass",
      {
        ruleset8: lockRuleset({
          bypass_actors: [
            {
              actor_id: 5,
              actor_type: "RepositoryRole",
              bypass_mode: "always",
            },
          ],
        }),
      },
    ],
    [
      "B does not block updates",
      { ruleset8: lockRuleset({ rules: [{ type: "deletion" }] }) },
    ],
    [
      "B does not block deletion",
      { ruleset8: lockRuleset({ rules: [{ type: "update" }] }) },
    ],
    ["B is not active", { ruleset8: lockRuleset({ enforcement: "evaluate" }) }],
    [
      "B excludes some v* tags",
      {
        ruleset8: lockRuleset({
          conditions: {
            ref_name: { include: ["refs/tags/v*"], exclude: ["refs/tags/v0*"] },
          },
        }),
      },
    ],
    ["no RELEASE_APP_ID given", { appId: null }],
    ["a non-numeric RELEASE_APP_ID", { appId: "release-please" }],
  ])("refuses the key upload with %s", (_n, o) => {
    const r = run(o);
    expect(r.code).not.toBe(0);
    expect(r.calls.some((c) => c.startsWith("gh secret set"))).toBe(false);
    expect(r.secret).toBeNull();
    expect(r.err).toMatch(/refusing/);
  });

  it("refuses an unknown env and an empty stdin before any call", () => {
    for (const o of [{ env: "dev" }, { input: "" }]) {
      const r = run(o);
      expect(r.code).not.toBe(0);
      expect(r.calls).toEqual([]);
    }
  });

  it("docs/ops/hosted.md's key-ceremony checklist lists every control and the script", () => {
    const doc = readFileSync(join(root, "docs/ops/hosted.md"), "utf8");
    const at = doc.indexOf("### Key-ceremony checklist");
    expect(at).toBeGreaterThan(-1);
    const section = doc.slice(at, doc.indexOf("\n### ", at + 4));
    expect(section).toContain("main");
    expect(section).toMatch(/deployment branch/i);
    expect(section).toMatch(/reviewer/i);
    expect(section).toMatch(/admin bypass/i);
    expect(section).toContain("can_admins_bypass");
    expect(section).toContain("gh api repos/{repo}/environments/");
    expect(section).toContain("gh api repos/{repo}/rulesets");
    expect(section).toContain("refs/tags/v*");
    expect(section).toMatch(/update/i);
    expect(section).toMatch(/delet/i);
    expect(section).toContain("RELEASE_APP_ID");
    expect(section).toContain("scripts/ops/hosted-set-signing-key.sh");
  });
});
