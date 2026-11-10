/** The bus name every agent falls back to when its proposal is unusable. */
export const FALLBACK_BUS_NAME = "agent";

/**
 * A name only the harness gave the session (#1742, #1860): the kind itself
 * (codex, opencode, pi, omp, hermes...), `<kind>-...`, the hub's `agent`, or
 * Claude's `claude-<digits>`. The one definition: the hub never reclaims such
 * a name, and `list_agents` folds away rows that carry one into a count.
 */
export function isFallbackName(name: string, kind: string): boolean {
  const lname = name.toLowerCase();
  return (
    lname === kind ||
    lname.startsWith(`${kind}-`) ||
    lname === FALLBACK_BUS_NAME ||
    /^claude-\d+$/.test(lname)
  );
}

/**
 * The from-name the instance uses for its own notices in a session (design:
 * Follow and notices). Reserved: no agent can register it or a look-alike.
 */
export const INSTANCE_SENDER_NAME = "open-artifacts";

/**
 * How every hint tells a user to run the CLI. The one place to change when
 * the package is published under another name or invoked another way (#1301).
 */
export const BUS_CMD = "npx @open-artifacts/bus";
