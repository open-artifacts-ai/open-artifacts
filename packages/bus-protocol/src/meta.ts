/** The bus name every agent falls back to when its proposal is unusable. */
export const FALLBACK_BUS_NAME = "agent";

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
