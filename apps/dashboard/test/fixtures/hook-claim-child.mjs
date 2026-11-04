// test/hook-ledger.test.ts: one process of the two-process race, run with
// node --experimental-strip-types. Claims a slot for argv app under argv
// root; after its scan found room it writes <tag>.ready and waits for `go`,
// so both processes have scanned before either creates. Prints "took <n>"
// or "refused".
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { claimHookSlot, HookBudgetError } = await import(
  new URL("../../e2e/staging/hook-ledger.ts", import.meta.url).href
);
const [root = "", app = "", tag = "", sync = ""] = process.argv.slice(2);
try {
  const n = await claimHookSlot(app, {
    root,
    // No room left: refuse at once instead of waiting.
    deadline: Date.now(),
    afterScan: async () => {
      writeFileSync(join(sync, `${tag}.ready`), "");
      while (!existsSync(join(sync, "go")))
        await new Promise((r) => setTimeout(r, 5));
    },
  });
  console.log(`took ${n}`);
} catch (e) {
  if (!(e instanceof HookBudgetError)) throw e;
  console.log("refused");
}
