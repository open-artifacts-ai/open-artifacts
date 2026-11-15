// Writes src/mcp/tool-manifest.json ([{ name, description }] for every MCP tool),
// consumed by the landing site. Gitignored: `pnpm gen` writes it; the
// package's build, test, test:cpu, bench and typecheck, and the landing's
// build, typecheck and test, run that first.
import path from "node:path";
import { TOOL_DEFS } from "../src/mcp/tool-defs.ts";
import { docToolOff } from "../src/services/doc-switch.ts";
import { writeGenerated } from "./write-generated.ts";

const out = path.join(
  import.meta.dirname,
  "..",
  "src",
  "mcp",
  "tool-manifest.json",
);
// Doc-gated tools (edit_doc, #1100) are public only once the doc switch
// opens, like tools/list and the skill; the docs page ships with the feature.
const manifest = TOOL_DEFS.filter((t) => !docToolOff(t.name)).map(
  ({ name, description }) => ({
    name,
    description,
  }),
);
writeGenerated(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `wrote ${manifest.length} tools to ${path.relative(process.cwd(), out)}`,
);
