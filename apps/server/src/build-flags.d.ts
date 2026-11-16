/**
 * Bundler define (wrangler `define`, vite `define`). The expression `true` in
 * test and staging builds; the release template sets the expression `false`,
 * so every `HOOKS_BUILD` folds to false and esbuild drops src/test-hooks/
 * from the bundle. Undefined in builds that don't set it (treated as false).
 */
declare const __OA_TEST_HOOKS_ALLOWED__: boolean | undefined;
/** DOCS_PREVIEW is honoured only where this is true (staging, tests; services/doc-switch.ts). */
declare const __OA_DOCS_PREVIEW_ALLOWED__: boolean | undefined;
