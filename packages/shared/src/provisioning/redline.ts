// R26 redline-creds PAT scope (design v7 10.1), no zod. W3's ManageInstall
// implements it; REDLINE_SCOPE_FIXTURE (fixtures.ts) is the two-install
// contract its tests must pass.

/** The label of every PAT R26 mints: `redline-<run id>`. */
export const REDLINE_PAT_PREFIX = "redline-";

export const isRedlinePatLabel = (label: unknown): boolean =>
  typeof label === "string" &&
  label.startsWith(REDLINE_PAT_PREFIX) &&
  label.length > REDLINE_PAT_PREFIX.length;

/** One PAT as W3 lists it on an install (the install's own token API). */
export interface RedlinePat {
  id: string;
  installId: string;
  label: string;
  revokedAt: number | null;
}

/**
 * The PATs an R26 job revokes, on `installId` only, never another install's:
 * every live `redline-*` PAT of it. Mint passes `keep` (the PAT it just
 * minted), so it sweeps the older ones; revoke (`revoke: true`) passes none.
 * An empty result is a no-op: a repeat revoke with nothing left to revoke
 * ends `done` without an error.
 */
export function redlinePatsToRevoke(
  installId: string,
  pats: readonly RedlinePat[],
  opts?: { keep?: string },
): string[] {
  return pats
    .filter(
      (p) =>
        p.installId === installId &&
        p.revokedAt === null &&
        isRedlinePatLabel(p.label) &&
        p.id !== opts?.keep,
    )
    .map((p) => p.id);
}
