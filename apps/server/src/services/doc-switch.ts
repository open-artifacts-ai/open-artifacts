/**
 * The switch for creating docs (#1100): the env var DOCS_ENABLED, "1" = on,
 * anything else or unset = off (off everywhere for now). Off: publishing
 * format "doc" is refused with docs_disabled, and tools/list and the skill
 * don't list it. No imports: the skill and manifest generators load this file.
 */
export const docsOn = (env: { DOCS_ENABLED?: string }): boolean =>
  env.DOCS_ENABLED === "1";
