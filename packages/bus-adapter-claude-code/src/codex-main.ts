import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { connectDaemon } from "@oa/bus-ipc";
import { codexServer } from "./codex.ts";
import { busHome } from "./session.ts";
import { daemonSocketPath, socketDirProblem } from "./socket-path.ts";

const HOME = busHome();
const SOCKET = daemonSocketPath(HOME);

const server = codexServer({
  connect: (hello) => {
    // A short socket folder another user could reach is never dialed.
    const problem = socketDirProblem(HOME);
    return problem
      ? Promise.reject(new Error(problem))
      : connectDaemon({ path: SOCKET, hello });
  },
});

await server.connect(new StdioServerTransport());
