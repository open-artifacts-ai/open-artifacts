// test/hook-ledger.test.ts: one process of the two-process race, run with
// node --experimental-strip-types. Claims a slot for argv app under argv
// root; after its scan found room it prints "ready" and waits for a line on
// stdin, so both processes have scanned before either creates. Then prints
// "took <n>" or "refused".

const { claimHookSlot, HookBudgetError } = await import(
  new URL("../../e2e/staging/hook-ledger.ts", import.meta.url).href
);
const [root = "", app = ""] = process.argv.slice(2);
try {
  const n = await claimHookSlot(app, {
    root,
    // No room left: refuse at once instead of waiting.
    deadline: Date.now(),
    afterScan: async () => {
      console.log("ready");
      await new Promise((go) => process.stdin.once("data", go));
      process.stdin.pause();
    },
  });
  console.log(`took ${n}`);
} catch (e) {
  if (!(e instanceof HookBudgetError)) throw e;
  console.log("refused");
}
