// Secrets on the user's machine: one source for setup, the generated skills
// (skill.md, upgrade.md, migrate.md) and the dashboard. The agent never asks
// for a secret in chat; the user saves it with secretSnippet's hidden-input
// line, and commands read the file. Dependency-free.

/** Setup's default install name (`--name`); the Worker name equals it. */
export const DEFAULT_INSTALL_NAME = "open-artifacts";

export type SecretKind = "cloudflare" | "access" | "analytics" | "pat";

/** The read prompt label per secret. */
export const SECRET_LABELS: Record<SecretKind, string> = {
  cloudflare: "Cloudflare deploy token",
  access: "Cloudflare Access token",
  analytics: "Cloudflare analytics token",
  pat: "Open Artifacts token",
};

/** The env var each tool reads the secret from (the PAT goes in a header). */
export const SECRET_ENV_VARS = {
  cloudflare: "CLOUDFLARE_API_TOKEN",
  access: "OA_ACCESS_TOKEN",
  analytics: "ANALYTICS_TOKEN",
} as const satisfies Record<Exclude<SecretKind, "pat">, string>;

/**
 * `host` as a name segment: lowercased, every run of characters outside
 * [a-z0-9] turned into one "-", trimmed of "-" at both ends.
 * "Staging.Open-Artifacts.com:8812" → "staging-open-artifacts-com-8812".
 */
export const hostSlug = (host: string): string =>
  host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "instance";

/**
 * Where a secret is saved: `~/.open-artifacts/<installName>-<kind>-token`
 * (installName defaults to DEFAULT_INSTALL_NAME; setup reads these files by
 * default), or `~/.open-artifacts/<hostSlug>-pat-token` for the PAT.
 */
export function secretFile(
  kind: SecretKind,
  ids: { installName?: string; hostSlug?: string } = {},
): string {
  if (kind === "pat") {
    if (!ids.hostSlug) throw new Error("secretFile(pat) needs hostSlug");
    return `~/.open-artifacts/${ids.hostSlug}-pat-token`;
  }
  return `~/.open-artifacts/${ids.installName ?? DEFAULT_INSTALL_NAME}-${kind}-token`;
}

/** The file's basename without its trailing "-token" (Platform's NAME). */
const nameOf = (file: string) =>
  file.slice(file.lastIndexOf("/") + 1).replace(/-token$/, "");

/**
 * Platform's hidden-input one-liner (verbatim but for the file name and the
 * prompt): saves the secret to ~/.open-artifacts/<basename of file> with
 * umask 077 (file 0600, dir 0700). The prompt reads `<label> (hidden, then Enter): `.
 */
export function secretSnippet(file: string, label: string): string {
  const NAME = nameOf(file);
  return `bash -c 'set -e; umask 077; d="$HOME/.open-artifacts"; mkdir -p "$d"; chmod 700 "$d"; read -rsp "${label} (hidden, then Enter): " T; echo; [ -n "$T" ] || { echo "nothing entered; not saved"; exit 1; }; rm -f "$d/${NAME}-token"; printf "%s" "$T" > "$d/${NAME}-token"; chmod 600 "$d/${NAME}-token"; echo "saved to $d/${NAME}-token"'`;
}

/**
 * The one rule that names a client: the `!` prefix runs a line in the user's
 * shell from inside Claude Code (tested 2026-10-20). Exported so the server's
 * vendor-neutrality test can allow exactly this sentence.
 */
export const BANG_RULE =
  "In Claude Code the user types `! ` followed by the line (input stays hidden); otherwise they run it in a regular terminal.";

/**
 * The rules shipped next to secretSnippet, as Markdown list items. Pass
 * `envVar` (and optionally `command`, default `pnpm --reporter=silent oa:setup …`) for
 * `VAR="$(cat <file>)" <command>`, or `usage` for any other form that reads
 * the file inside the command (e.g. a curl header).
 */
export function secretRules(
  opts: { file: string } & (
    | { envVar: string; command?: string }
    | { usage: string }
  ),
): string {
  const usage =
    "usage" in opts
      ? opts.usage
      : `${opts.envVar}="$(cat ${opts.file})" ${opts.command ?? "pnpm --reporter=silent oa:setup …"}`;
  return `- Never ask for the token in chat. Hand the user the line above. ${BANG_RULE} Never print, echo or log the value.
- Read the file only to pass it on, inside the command you run: \`${usage}\`. Never put the value in text you show.
- The file (${opts.file}) is mode 0600 in a 0700 directory. To rotate, run the line again (it overwrites the file); delete the file when it is no longer needed.
- If \`read\` fails because there is no terminal, ask the user to run the line in a regular terminal window.`;
}
