// Run by connect.test.ts in a child process: opens a link, then has nothing
// else to do. It must exit by itself; the link may not keep it alive.
import { Bus } from "../src/bus.ts";
import { realConnect } from "../src/link.ts";

const bus = new Bus({
  connect: realConnect({ OA_BUS_HOME: process.argv[2] }),
  stateDir: () => "/state/.openclaw",
  habitsOn: () => true,
});
// promptBuild waits for the link to open. The link is unref'd, so hold the
// loop until it answers; the hold is released before the exit that is tested.
const hold = setInterval(() => {}, 2 ** 30);
await bus.promptBuild({
  agentId: "main",
  sessionKey: "agent:main:main",
  trigger: "user",
  runId: "r",
});
clearInterval(hold);
console.log(
  bus.buildPrompt({
    agentId: "main",
    sessionKey: "agent:main:main",
    trigger: "user",
    runId: "r2",
  })?.appendSystemContext
    ? "link-open"
    : "link-closed",
);
