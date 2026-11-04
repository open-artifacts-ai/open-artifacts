// Bundles the CLI and everything it imports into dist/index.js, and copies the
// adapters' assets to assets/, where `new URL("../assets/…", import.meta.url)`
// finds them from dist/ just as it does from each adapter's src/.
import {
  chmodSync,
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { stampPi } from "./stamp.mjs";

const root = join(import.meta.dirname, "..");
const at = (p) => join(root, p);
// OA_BUS_CLI_VERSION stamps a release version on a local build (e2e/codex): the
// package says 0.0.0 until publish-npm sets the tag's. Never when packing,
// so a stray export cannot ship as the published version.
const packing = ["prepack", "prepublishOnly", "prepare"].includes(
  process.env.npm_lifecycle_event ?? "",
);
const version =
  (!packing && process.env.OA_BUS_CLI_VERSION) ||
  JSON.parse(readFileSync(at("package.json"), "utf8")).version;

rmSync(at("dist"), { recursive: true, force: true });
rmSync(at("assets"), { recursive: true, force: true });

await build({
  entryPoints: [at("src/cli.ts")],
  outfile: at("dist/index.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  // ESM first: some CommonJS mains are UMD wrappers esbuild cannot follow.
  mainFields: ["module", "main"],
  // CommonJS dependencies require node built-ins.
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __obCreateRequire } from "node:module";',
      "const require = __obCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  define: { __OA_BUS_VERSION__: JSON.stringify(version) },
  // ws's optional native add-ons: required in a try, absent is fine.
  external: ["bufferutil", "utf-8-validate"],
  legalComments: "none",
  logLevel: "warning",
});
// The bin runs straight from a package, not only through npm's link.
chmodSync(at("dist/index.js"), 0o755);

mkdirSync(at("assets"), { recursive: true });
writeFileSync(
  at("assets/oa-bus.ts"),
  stampPi(
    readFileSync(at("../bus-adapter-pi/assets/oa-bus.ts"), "utf8"),
    version,
  ),
);
cpSync(
  at("../bus-adapter-opencode/assets/opencode-tui/tui.js"),
  at("assets/opencode-tui/tui.js"),
);
