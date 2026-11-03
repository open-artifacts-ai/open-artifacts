/**
 * Compile-time define, confirmed by Backend: a BOOLEAN literal, `true` only in
 * the redline bundle and `false` in the release bundle.
 */
export const TEST_HOOKS_DEFINE = "__OA_TEST_HOOKS_ALLOWED__" as const;

export type BundleVariant = "release" | "redline";
