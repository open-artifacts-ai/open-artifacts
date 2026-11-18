/**
 * The switch for creating docs (#1100): open since edit_doc and the doc room
 * shipped. Set it to false to hide docs everywhere again. docsAvailable
 * (docs-available.ts) also needs a paid plan or a hosted install. An object so
 * a test can open it for one file. No imports: the skill and manifest
 * generators load this file.
 */
export const DOC_SWITCH: { creation: boolean } = { creation: true };

/**
 * Tools that exist (TOOL_DEFS, TOOL_POLICY) but are offered, written into the
 * manifest and described in the skill only while DOC_SWITCH.creation is open.
 * Every generator and every tool-set test reads this one list.
 */
export const DOC_GATED_TOOLS: readonly string[] = ["edit_doc"];

/** The tool is gated off by the doc switch right now. */
export const docToolOff = (name: string): boolean =>
  DOC_GATED_TOOLS.includes(name) && !DOC_SWITCH.creation;
