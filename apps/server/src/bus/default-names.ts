/**
 * #2311: true when `name` is still the harness's own default for an agent of
 * `kind`: a name the hub minted for this agent (`minted`: `<base>-<4 hex>`),
 * the kind itself, `agent`, or a harness default tied to its own kind:
 * `claude-<digits>` for claude-code, `pi|omp` for the pi kinds, `codex` for
 * codex, each optionally followed by digits only (`pi-2`, `agent-3`, a
 * collision suffix). #2318: a name that is another kind's default (a Claude
 * session titled `codex`) is a chosen name. A name with
 * words after the kind (`pi-docs`, `codex-reviewer`) is not one: a person or
 * the harness's session title may have set it. A role holder is never default
 * either; callers check that in SQL.
 */
export function isDefaultAgentName(
  name: string,
  kind: string,
  minted: boolean,
): boolean {
  if (minted) return true;
  const l = name.toLowerCase();
  const k = kind.toLowerCase();
  return (
    l === k ||
    (k === "claude-code" && /^claude-\d+$/.test(l)) ||
    ((k === "pi" || k === "omp") && /^(pi|omp)(-\d+)*$/.test(l)) ||
    (k === "codex" && /^codex(-\d+)*$/.test(l)) ||
    /^agent(-\d+)*$/.test(l) ||
    (/^[a-z0-9_]+-\d+$/.test(l) && l.slice(0, l.lastIndexOf("-")) === k)
  );
}
