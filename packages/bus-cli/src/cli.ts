// The bundle's entry: `oa-bus <argv>`.
import "./harness-table.ts";
import { main } from "./main.ts";

const code = await main(process.argv.slice(2));
if (code !== undefined) process.exit(code);
