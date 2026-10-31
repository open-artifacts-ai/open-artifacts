// The redline-staging job's Provisioning API steps (design v7 4.4, 10.1, 12.2):
//   node --experimental-strip-types scripts/provisioning.ts mint-oidc <key>...
//   node --experimental-strip-types scripts/provisioning.ts bringup
//   node --experimental-strip-types scripts/provisioning.ts revoke
// mint-oidc writes one GitHub OIDC JWT per audience key (provisioning,
// stagingInventory, prodInventory) into REDLINE_TARGETS.secretsDir as 0600
// files. bringup upgrades rl-a and rl-b to REDLINE_RELEASE (R5) and writes
// their R26 creds (REDLINE_RL_<X>_PAT, _HOOK_KEY). revoke is the job's
// if: always() end: R26 revoke on both, and their PATs must then be 401.
// Every value is masked (::add-mask::) before anything else could print it.
import type { AudienceKey } from "../src/oidc.ts";
import { AUDIENCES } from "../src/oidc.ts";
import {
  bringUp,
  mintFiles,
  rawTargets,
  revokeAll,
} from "../src/provisioning-live.ts";

const [cmd, ...rest] = process.argv.slice(2);
const env = process.env;

async function main(): Promise<number> {
  const t = rawTargets(env.REDLINE_TARGETS);
  if (cmd === "mint-oidc") {
    const keys = rest as AudienceKey[];
    if (!keys.length || !keys.every((k) => k in AUDIENCES))
      throw new Error(
        `mint-oidc: keys are ${Object.keys(AUDIENCES).join(", ")}`,
      );
    await mintFiles(env, t.secretsDir, keys);
    return 0;
  }
  if (cmd === "bringup") {
    await bringUp(env, t);
    return 0;
  }
  if (cmd === "revoke") return revokeAll(env, t);
  throw new Error(
    "usage: provisioning.ts mint-oidc <key>... | bringup | revoke",
  );
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`provisioning: ${(e as Error).message}`);
    process.exit(1);
  },
);
