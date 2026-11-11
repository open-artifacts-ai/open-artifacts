// Bundles the plugin into dist/: a folder OpenClaw can install as it is
// (`openclaw plugins install --link dist`). Only `openclaw/*` stays external:
// OpenClaw provides it. bus-ipc, zod and the adapter helpers are inlined.
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const root = join(import.meta.dirname, "..");
const at = (p) => join(root, p);
// OA_BUS_OPENCLAW_OUT: another build (bus-cli's bundle) writes here instead of dist/, so two builds never share a folder.
const out = process.env.OA_BUS_OPENCLAW_OUT
  ? resolve(process.env.OA_BUS_OPENCLAW_OUT)
  : at("dist");
const pkg = JSON.parse(readFileSync(at("package.json"), "utf8"));
const version = process.env.OA_BUS_CLI_VERSION || pkg.version;

rmSync(out, { recursive: true, force: true });
await build({
  entryPoints: [at("src/plugin.ts")],
  outfile: join(out, "index.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  mainFields: ["module", "main"],
  banner: {
    js: [
      'import { createRequire as __ocCreateRequire } from "node:module";',
      "const require = __ocCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  define: { __OA_BUS_VERSION__: JSON.stringify(version) },
  external: ["openclaw", "openclaw/*"],
  legalComments: "none",
  logLevel: "warning",
});
mkdirSync(out, { recursive: true });
copyFileSync(at("openclaw.plugin.json"), join(out, "openclaw.plugin.json"));
writeFileSync(
  join(out, "package.json"),
  `${JSON.stringify(
    {
      name: "oa-bus",
      version,
      type: "module",
      openclaw: { ...pkg.openclaw, extensions: ["./index.js"] },
    },
    null,
    2,
  )}\n`,
);
