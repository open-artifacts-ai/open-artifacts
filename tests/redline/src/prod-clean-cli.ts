import { pathToFileURL } from "node:url";
import { type ProdCleanOpts, ProdDirty, prodClean } from "./prod.ts";
import { type ProdProbe, parseProd } from "./targets.ts";

// The "prod is clean" precheck hosted-ops.yml runs before a prod create or
// upgrade: prodClean, exit 0 only on a pass. not-applicable passes only for
// create, and only when the inventory read back an empty installs list (no
// prod install yet); anything else (a fail, an error, an unproven result) is
// exit 1. Env: OPS_OP, REDLINE_PROD_SECRETS_DIR (the 0600 token files),
// REDLINE_PROD_ACCOUNT_ID, REDLINE_PROD_INVENTORY_URL.

export const GATED_OPS = ["create", "upgrade"] as const;

export interface Verdict {
  code: 0 | 1;
  line: string;
}

/** Runs prodClean through `o.fetch`, watching for the inventory's own empty list. */
export async function prodCleanGate(
  op: string,
  p: ProdProbe,
  o: ProdCleanOpts = {},
): Promise<Verdict> {
  if (!(GATED_OPS as readonly string[]).includes(op))
    return { code: 1, line: `prod-clean: refused: op ${op.slice(0, 20)}` };
  const base = o.fetch ?? fetch;
  const inventory = p.inventoryUrl ? `${p.inventoryUrl}/installs` : null;
  let emptyInventory = false;
  const watched: typeof fetch = async (input, init) => {
    const res = await base(input, init);
    const url = input instanceof Request ? input.url : String(input);
    if (inventory && url === inventory) {
      emptyInventory = false;
      if (res.status === 200)
        try {
          const v = (await res.clone().json()) as { installs?: unknown };
          emptyInventory = Array.isArray(v.installs) && v.installs.length === 0;
        } catch {}
    }
    return res;
  };
  let r: Awaited<ReturnType<typeof prodClean>>;
  try {
    r = await prodClean(p, { ...o, fetch: watched });
  } catch (e) {
    if (e instanceof ProdDirty)
      return { code: 1, line: `prod-clean: fail: ${e.message}` };
    const what = e instanceof Error ? `${e.name}: ${e.message}` : "unknown";
    return { code: 1, line: `prod-clean: error: ${what.slice(0, 200)}` };
  }
  if (r.level === "pass")
    return {
      code: 0,
      line: `prod-clean: pass (${r.releases} releases, ${r.installs} installs)`,
    };
  if (r.level === "not-applicable" && op === "create" && emptyInventory)
    return {
      code: 0,
      line: `prod-clean: not-applicable (${r.reason}), allowed for create: the inventory lists no install`,
    };
  return { code: 1, line: `prod-clean: unproven for ${op}: not a pass` };
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
  } catch (e) {
    io.err(
      `prod-clean: error: ${(e instanceof Error ? e.message : "unknown").slice(0, 200)}`,
    );
    return 1;
  }
  if (!p) {
    io.err("prod-clean: error: the prod probe is not configured");
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
