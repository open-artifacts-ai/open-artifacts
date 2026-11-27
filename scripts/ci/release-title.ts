// A pull request that changes what installs serve to agents (the skill, the
// upgrade guide, llms.txt, the MCP instructions and tool text) must open a
// release: its title (the squash commit's subject, which release-please reads)
// is `fix:`, `feat:` (with any scope) or a breaking change (`type!:`). Any
// other title (`test:`, `docs:`, `chore:`, `ci:`, `refactor:`, or no type at
// all) ships in no release. Without this, a skill fix titled `docs:` lands on
// main and no install serves it until some unrelated fix cuts a release.
// Usage (CI, pull_request): PR_TITLE, PR_NUMBER, GH_TOKEN in the environment;
// node --experimental-strip-types scripts/ci/release-title.ts --repo owner/name
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** Paths whose content installs serve to agents. */
export const SERVED: readonly RegExp[] = [
  // /skill.md, /skill/<part>.md, /upgrade.md, /llms.txt, the MCP server
  // instructions, the runtime doc resource and every tool's description.
  /^apps\/server\/src\/mcp\//,
  // The build steps that turn the skill and upgrade templates into what is
  // served.
  /^apps\/server\/scripts\/emit-(skill|upgrade)\.ts$/,
];

/** The title types that open a release (a breaking `type!:` does too). */
export const RELEASING = new Set(["fix", "feat"]);

const TYPE = /^([a-z]+)(\([^)]*\))?(!)?:/i;

export type Verdict =
  | { ok: true }
  | { ok: false; type: string; served: string[] };

/** Fails any title but fix:, feat: or a breaking change on a served path. */
export function check(title: string, files: string[]): Verdict {
  const served = files.filter((f) => SERVED.some((r) => r.test(f)));
  if (!served.length) return { ok: true };
  const m = TYPE.exec(title.trim());
  // A breaking change (`chore!:`) releases whatever its type.
  if (m?.[3]) return { ok: true };
  const type = m ? (m[1] as string).toLowerCase() : "";
  return RELEASING.has(type) ? { ok: true } : { ok: false, type, served };
}

export function message(v: Verdict & { ok: false }): string {
  return [
    v.type
      ? `This PR is titled \`${v.type}:\` but changes what installs serve to agents:`
      : "This PR's title has no fix: or feat: type, but it changes what installs serve to agents:",
    ...v.served.map((f) => `  ${f}`),
    "release-please opens a release only for fix:, feat: or a breaking change (type!:), so no install would serve this change.",
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
