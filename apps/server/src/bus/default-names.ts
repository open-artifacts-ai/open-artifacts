import { isFallbackName } from "@oa/bus-protocol";

/**
 * #2311: true when `name` is still the harness's own default for an agent of
 * `kind`: the fallback names (isFallbackName: `<kind>`, `<kind>-...`, `agent`,
 * `claude-<digits>`), `pi`/`omp`/`codex`/`agent` with any `-N` suffixes (also
 * the collision suffixes), or a name the hub minted for this agent
 * (`minted`: `<base>-<4 hex>`). A name the user chose or a role gave never
 * matches, bar the rare chosen name that reads like a default.
 */
export function isDefaultAgentName(
  name: string,
  kind: string,
  minted: boolean,
): boolean {
  return (
    minted ||
    isFallbackName(name, kind) ||
    /^(pi|omp|codex|agent|claude)(-\d+)+$|^(pi|omp|codex)$/i.test(name)
  );
}
