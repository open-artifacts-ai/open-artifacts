// A pull request that changes shipped code (apps/**, packages/**) must open a
// release: its title (the squash commit's subject, which release-please reads)
// is lowercase `fix:`, `feat:` (with any scope) or a breaking change
// (`type!:`). Any other title (`test:`, `docs:`, `chore:`, `ci:`, `refactor:`,
// `perf:`, or no type at all) ships in no release. Without this, a fix lands
// on main and sits unreleased until some unrelated fix cuts a release (#3367).
// Usage (CI, pull_request): PR_TITLE, PR_NUMBER, GH_TOKEN in the environment;
// node --experimental-strip-types scripts/ci/release-title.ts --repo owner/name
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** Top-level trees holding shipped code and assets (matched by release-title.yml `paths`). */
export const SHIPPED_TREES: readonly RegExp[] = [/^apps\//, /^packages\//];

/**
 * Non-shipped paths inside `apps/` or `packages/`: tests, test configs,
 * test fixtures, dev/story harnesses and package-root docs. Everything else
 * under `apps/` or `packages/` is treated as shipped (fail-closed for new
 * apps, packages, migrations, assets or plugins).
 */
export const NOT_SHIPPED: readonly RegExp[] = [
  /^[^/]+\/[^/]+\/(?:test|tests|e2e|test-browser|test-workerd|test-setup|fixtures|ladle|\.ladle|dev|design|docs)\//,
  /\.(?:test|spec|stories)\.[cm]?[jt]sx?$/,
  /^[^/]+\/[^/]+\/(?:vitest|playwright)(?:\.[^/]+)?\.config\.[cm]?[jt]s$/,
  /^[^/]+\/[^/]+\/wrangler\.[^/]*test[^/]*\.jsonc$/,
  /^[^/]+\/[^/]+\/[^/]+\.md$/,
];

/** Whether a changed file path ships in a release (apps/** or packages/**, excluding tests/docs). */
export function isShipped(file: string): boolean {
  return (
    SHIPPED_TREES.some((r) => r.test(file)) &&
    !NOT_SHIPPED.some((r) => r.test(file))
  );
}

/** The title types that open a release (a breaking `type!:` does too). */
export const RELEASING = new Set(["fix", "feat"]);

// Conventional Commit header release-please parses: `type[(scope)][!]: subject`.
const HEADER = /^([a-z]+)(?:\([^)\r\n]+\))?(!)?:\s+\S/i;

export type Verdict =
  | { ok: true }
  | { ok: false; type: string; shipped: string[] };

/** Fails any title but lowercase fix:, feat: or a breaking change on a shipped path. */
export function check(title: string, files: string[]): Verdict {
  const shipped = [...new Set(files.filter(isShipped))];
  if (!shipped.length) return { ok: true };
  const m = HEADER.exec(title.trim());
  if (!m) return { ok: false, type: "", shipped };
  const raw = m[1] as string;
  const lower = raw.toLowerCase();
  const isLower = raw === lower;
  // A breaking change (`chore!:`) releases whatever its type, when lowercase.
  if (isLower && (m[2] || RELEASING.has(lower))) return { ok: true };
  const type = !isLower && (m[2] || RELEASING.has(lower)) ? raw : lower;
  return { ok: false, type, shipped };
}

export function message(v: Verdict & { ok: false }): string {
  return [
    v.type
      ? `This PR is titled \`${v.type}:\` but changes shipped code:`
      : "This PR's title has no fix: or feat: type, but it changes shipped code:",
    ...v.shipped.map((f) => `  ${f}`),
    "release-please opens a release only for fix:, feat: or a breaking change (type!:), so this change would sit unreleased on main.",
    "Retitle it fix: or feat: so it opens a release.",
  ].join("\n");
}

export type Exec = (
  cmd: string,
  args: string[],
) => { code: number; stdout: string; stderr: string };

/** The files the PR changes, from the API (no checkout of its history). */
export function changedFiles(exec: Exec, repo: string, pr: number): string[] {
  const r = exec("gh", [
    "api",
    "--paginate",
    `repos/${repo}/pulls/${pr}/files?per_page=100`,
    "--jq",
    ".[] | .filename, (.previous_filename // empty)",
  ]);
  if (r.code !== 0)
    throw new Error(`gh api pulls/${pr}/files: ${r.stderr.trim()}`);
  return r.stdout.split("\n").filter(Boolean);
}

const realExec: Exec = (cmd, args) => {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
};

function main(argv: string[]): number {
  const repo = argv[argv.indexOf("--repo") + 1] ?? "";
  const pr = Number(process.env.PR_NUMBER);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isSafeInteger(pr)) {
    console.error(
      "usage: PR_TITLE=... PR_NUMBER=n release-title.ts --repo o/n",
    );
    return 2;
  }
  const v = check(process.env.PR_TITLE ?? "", changedFiles(realExec, repo, pr));
  if (v.ok) {
    console.log("release-title: ok");
    return 0;
  }
  console.error(message(v));
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exit(main(process.argv.slice(2)));
