/**
 * The switch for creating docs (#1100): `creation` is false until edit_doc and
 * the doc room ship; the PR that ships them flips it. docsAvailable
 * (docs-available.ts) also needs a paid plan or a hosted install. An object so
 * a test can open it for one file. No imports: the skill and manifest
 * generators load this file.
 */
export const DOC_SWITCH: { creation: boolean } = { creation: false };

declare const __OA_DOCS_PREVIEW_ALLOWED__: boolean | undefined;
/**
 * Build-time guard, like the test hooks': true only where the bundler defines
 * `__OA_DOCS_PREVIEW_ALLOWED__` as true (wrangler.staging.jsonc and the test
 * builds). The release template defines it false, so a release bundle ignores
 * DOCS_PREVIEW whatever a config sets.
 */
export const DOCS_PREVIEW_ALLOWED: boolean =
  typeof __OA_DOCS_PREVIEW_ALLOWED__ !== "undefined" &&
  __OA_DOCS_PREVIEW_ALLOWED__ === true;

/**
 * Whether doc creation is open for this deployment: DOC_SWITCH.creation, or
 * DOCS_PREVIEW=1 in a build that allows it (an unsupported preview; see env.ts).
 * Every reader of the switch goes through here. No imports.
 */
export const docCreationOpen = (
  env: { DOCS_PREVIEW?: string },
  previewAllowed: boolean = DOCS_PREVIEW_ALLOWED,
): boolean =>
  DOC_SWITCH.creation || (previewAllowed && env.DOCS_PREVIEW === "1");

/**
 * Tools that exist (TOOL_DEFS, TOOL_POLICY) but are offered, written into the
 * manifest and described in the skill only while DOC_SWITCH.creation is open.
 * Every generator and every tool-set test reads this one list.
 */
export const DOC_GATED_TOOLS: readonly string[] = ["edit_doc"];

/** The tool is gated off by the doc switch right now. */
export const docToolOff = (name: string): boolean =>
  DOC_GATED_TOOLS.includes(name) && !DOC_SWITCH.creation;
