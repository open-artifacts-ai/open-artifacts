import { pathToFileURL } from "node:url";
import {
  type ProdCleanOpts,
  ProdDirty,
  prodClean,
  prodCleanLine,
} from "./prod.ts";
import { type ProdProbe, parseProd } from "./targets.ts";

// The "prod is clean" precheck hosted-ops.yml runs before a prod create or
// upgrade: prodClean, exit 0 only on a pass. A configured prod with no
// release or no install passes; an unconfigured probe fails (2026-10-30).
// The repo is public, so the one line is `prod-clean: pass` or
// `prod-clean: fail (<code>)`, never a detail. Env: OPS_OP,
// REDLINE_PROD_SECRETS_DIR (the 0600 token files), REDLINE_PROD_ACCOUNT_ID,
// REDLINE_PROD_INVENTORY_URL.

export const GATED_OPS = ["create", "upgrade"] as const;

export interface Verdict {
  code: 0 | 1;
  line: string;
}

export async function prodCleanGate(
  op: string,
  p: ProdProbe | undefined,
  o: ProdCleanOpts = {},
): Promise<Verdict> {
  if (!(GATED_OPS as readonly string[]).includes(op))
    return { code: 1, line: prodCleanLine("refused_op") };
  try {
    await prodClean(p, o);
    return { code: 0, line: prodCleanLine() };
  } catch (e) {
    return {
      code: 1,
      line: prodCleanLine(e instanceof ProdDirty ? e.code : "error"),
    };
  }
}

export async function run(
  env: Record<string, string | undefined>,
  io: { out: (s: string) => void; err: (s: string) => void },
  o: ProdCleanOpts = {},
): Promise<0 | 1> {
  let p: ProdProbe | undefined;
  try {
    const url = env.REDLINE_PROD_INVENTORY_URL;
    p = parseProd(
      url ? { inventoryUrl: url } : undefined,
      env.REDLINE_PROD_SECRETS_DIR || undefined,
      env,
    );
  } catch {
    io.err(prodCleanLine("not_configured"));
    return 1;
  }
  const v = await prodCleanGate(env.OPS_OP ?? "", p, o);
  (v.code === 0 ? io.out : io.err)(v.line);
  return v.code;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await run(process.env, {
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
  });
}
