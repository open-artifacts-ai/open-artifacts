// Runs in a real second process to exercise process death and concurrent uninstall.
import { uninstallAdapters } from "../../src/steps/adapters.ts";
import { withAgyConfigLock } from "../../src/steps/agy-config-lock.ts";

const [operation, home, busHome] = process.argv.slice(2);
if (operation === "exit") {
  await withAgyConfigLock(home, () => process.exit(42));
} else {
  const result = await uninstallAdapters({
    home,
    busHome,
    hub: "https://artifacts.example.com",
    busBin: ["/opt/node/bin/node", "/h/.oa-bus/bin/oa-bus.js"],
    env: { OA_BUS_EXPERIMENTAL_AGY: "1" },
    assets: { pi: "", opencodePlugin: "" },
    which: () => false,
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  });
  if (result.skipped.some((s) => s.harness === "antigravity"))
    process.exitCode = 1;
}
