import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A 0600 namespaces.json approving each `[dir, namespace]` pair (#1525); returns its path. */
export function approvals(...pairs: [dir: string, namespace: string][]) {
  const file = join(
    realpathSync(mkdtempSync(join(tmpdir(), "ob-appr-"))),
    "namespaces.json",
  );
  writeFileSync(
    file,
    JSON.stringify({
      approved: pairs.map(([dir, namespace]) => ({ dir, namespace })),
    }),
    { mode: 0o600 },
  );
  return file;
}
