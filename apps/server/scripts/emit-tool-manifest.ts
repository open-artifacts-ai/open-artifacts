// Writes src/mcp/tool-manifest.json ([{ name, description }] for every MCP tool),
// consumed by the landing site. Gitignored: `pnpm gen` writes it; the
// package's build, test, test:cpu, bench and typecheck, and the landing's
// build, typecheck and test, run that first.
import path from "node:path";
import { TOOL_DEFS } from "../src/mcp/tool-defs.ts";
import { DOC_SWITCH } from "../src/services/doc-switch.ts";
import { writeGenerated } from "./write-generated.ts";

const out = path.join(
  import.meta.dirname,
  "..",
  "src",
  "mcp",
  "tool-manifest.json",
);
// edit_doc is public only once the doc switch opens (#1100), like tools/list
// and the skill; the docs page ships with the feature.
const manifest = TOOL_DEFS.filter(
  (t) => DOC_SWITCH.creation || t.name !== "edit_doc",
).map(({ name, description }) => ({
  name,
  description,
}));
writeGenerated(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `wrote ${manifest.length} tools to ${path.relative(process.cwd(), out)}`,
);
