import { uninstallAdapters } from "../../src/steps/adapters.ts";

const [home, busHome] = process.argv.slice(2);
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
