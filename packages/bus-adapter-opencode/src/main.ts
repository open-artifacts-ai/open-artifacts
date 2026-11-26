import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { busHome } from "@oa/bus-adapter-claude-code";
import { createServer } from "./server.ts";

const server = createServer(busHome());
await server.connect(new StdioServerTransport());
