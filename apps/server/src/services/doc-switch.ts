/**
 * The switch for creating docs (#1100): `creation` is false until edit_doc and
 * the doc room ship; the PR that ships them flips it. docsAvailable
 * (docs-available.ts) also needs a paid plan or a hosted install. An object so
 * a test can open it for one file. No imports: the skill and manifest
 * generators load this file.
 */
export const DOC_SWITCH: { creation: boolean } = { creation: false };
