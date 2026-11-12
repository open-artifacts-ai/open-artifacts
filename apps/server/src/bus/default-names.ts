/**
 * #2311: true when `name` is still the harness's own default for an agent of
 * `kind`: a name the hub minted for this agent (`minted`: `<base>-<4 hex>`),
 * the kind itself, `agent`, `claude-<digits>`, or `<kind|agent|pi|omp|codex>`
 * followed by digits only (`pi-2`, `agent-3`, a collision suffix). A name with
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
  return (
    l === kind.toLowerCase() ||
    /^claude-\d+$/.test(l) ||
    /^(pi|omp|codex|agent)(-\d+)*$/.test(l) ||
    (/^[a-z0-9_]+-\d+$/.test(l) &&
      l.slice(0, l.lastIndexOf("-")) === kind.toLowerCase())
  );
}
