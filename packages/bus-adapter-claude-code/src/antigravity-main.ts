import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { connectDaemon } from "@oa/bus-ipc";
import { antigravityServer } from "./antigravity.ts";
import { busHome, procStartOf } from "./session.ts";
import { daemonSocketPath, socketDirProblem } from "./socket-path.ts";

// Home and socket are resolved per call, so a restarted daemon is found (#2364).
const server = antigravityServer({
  busHome: () => busHome(),
  procStart: procStartOf,
  connect: (hello) => {
    const home = busHome();
    // A short socket folder another user could reach is never dialed.
    const problem = socketDirProblem(home);
    return problem
      ? Promise.reject(new Error(problem))
      : connectDaemon({ path: daemonSocketPath(home), hello });
  },
});

await server.connect(new StdioServerTransport());
