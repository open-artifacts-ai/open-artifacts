import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import { parseTemplate } from "./template.js";
import { readTreeHardened } from "./tree.js";
import { type BundleVariant, TEST_HOOKS_DEFINE } from "./variant.js";

export type Exec = (
  cmd: string,
  args: string[],
  opts: { cwd: string },
) => Promise<void>;

const run = promisify(execFile);
const defaultExec: Exec = async (cmd, args, opts) => {
  await run(cmd, args, { cwd: opts.cwd, maxBuffer: 64 * 1024 * 1024 });
};

export interface Bundle {
  modules: { name: string; type: "esm" | "wasm"; bytes: Uint8Array }[];
  mainModule: string;
  assetsDir: string;
  version: string;
  variant: BundleVariant;
  /**
   * The exact dry-run config wrangler built from (JSON). hosted-build requires
   * the two variants' configs to be byte-identical but for the define value.
   */
  config: string;
}

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const ZERO_ID = "00000000000000000000000000000000";

/**
 * Build the server once per release and variant with a dry-run deploy and
 * dummy values. Both variants come from the same config; the only difference
 * is the TEST_HOOKS_DEFINE define: "false" for release, "true" for redline.
 */
export async function buildBundle(
  root: string,
  o: { variant?: BundleVariant; exec?: Exec } = {},
): Promise<Bundle> {
  const variant = o.variant ?? "release";
  if (variant !== "release" && variant !== "redline")
    throw new Error("variant must be release or redline");
  const exec = o.exec ?? defaultExec;
  const tmp = await mkdtemp(join(tmpdir(), "oa-bundle-"));
  try {
    const serverDir = join(root, "apps/server");
    const tpl = parseTemplate(
      await readFile(join(serverDir, "wrangler.template.jsonc"), "utf8"),
    );
    // Dummy values; paths made absolute because the config lives in tmp.
    const dummy = JSON.parse(
      JSON.stringify(tpl)
        .replace(/\{\{WORKER_NAME\}\}/g, "oa-bundle")
        .replace(/\{\{(\w*HOST)\}\}/g, "x.invalid")
        .replace(/\{\{(D1_NAME|R2_BUCKET)\}\}/g, "oa-bundle")
        .replace(/\{\{D1_ID\}\}/g, ZERO_UUID)
        .replace(/\{\{KV_ID\}\}/g, ZERO_ID)
        .replace(/\{\{(\w+)\}\}/g, "x"),
    );
    dummy.routes = undefined;
    dummy.triggers = undefined;
    dummy.main = join(serverDir, tpl.main);
    if (dummy.assets)
      dummy.assets.directory = join(serverDir, dummy.assets.directory);
    for (const d of dummy.d1_databases ?? [])
      if (d.migrations_dir)
        d.migrations_dir = join(serverDir, d.migrations_dir);
    dummy.define = {
      ...(dummy.define ?? {}),
      [TEST_HOOKS_DEFINE]: variant === "redline" ? "true" : "false",
    };
    const config = join(tmp, "wrangler.json");
    const rendered = JSON.stringify(dummy);
    await writeFile(config, rendered);
    const outdir = join(tmp, "out");
    await mkdir(outdir, { recursive: true });
    await exec(
      "pnpm",
      [
        "--dir",
        "apps/server",
        "exec",
        "wrangler",
        "deploy",
        "--dry-run",
        "--outdir",
        outdir,
        "-c",
        config,
      ],
      { cwd: root },
    );
    const modules: Bundle["modules"] = [];
    // The hardened reader: no symlink, hardlink or swap in the outdir.
    for (const f of await readTreeHardened(outdir)) {
      const ext = extname(f.path);
      const type =
        ext === ".wasm"
          ? "wasm"
          : ext === ".js" || ext === ".mjs"
            ? "esm"
            : null;
      if (!type) {
        if (ext === ".map" || f.path === "README.md") continue;
        throw new Error(
          `unexpected wrangler output ${f.path}: only .js, .mjs and .wasm modules are supported`,
        );
      }
      modules.push({ name: f.path, type, bytes: f.bytes });
    }
    const main = `${basename(tpl.main, extname(tpl.main))}.js`;
    if (!modules.some((m) => m.name === main && m.type === "esm"))
      throw new Error(`wrangler output has no ${main}`);
    const pkg = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    ) as {
      version: string;
    };
    return {
      modules,
      mainModule: main,
      assetsDir: "apps/server/dist-assets",
      version: pkg.version,
      variant,
      config: rendered,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
