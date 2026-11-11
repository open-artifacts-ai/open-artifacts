/**
 * The one switch for creating docs (#1100). Off: publishing format "doc" is
 * refused (DOCS_UNAVAILABLE_MESSAGE) and no tool, skill or doc advertises it.
 * The PR that ships edit_doc and the doc room flips it. No imports: the skill
 * and manifest generators load this file directly. `DOCS_ENABLED=1` in the
 * environment turns it on for one deployment (tests, staging) without the flip.
 */
export const DOC_CREATION = false;

/** Whether this deployment creates docs. */
export const docsOn = (env: { DOCS_ENABLED?: string }): boolean =>
  DOC_CREATION || env.DOCS_ENABLED === "1";
