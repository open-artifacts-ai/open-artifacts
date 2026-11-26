import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { antigravityServer } from "./antigravity.ts";

await antigravityServer().connect(new StdioServerTransport());
