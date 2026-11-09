// Run by unref-pending.test.ts in a child process: one request, then nothing
// else to do. It must see the reply, then exit by itself.
import { connectDaemon } from "@oa/bus-ipc";

const c = await connectDaemon({
  path: process.argv[2] as string,
  unref: true,
  hello: {
    v: 1,
    id: "h",
    type: "hello",
    kind: "openclaw",
    agent_ref: "oa-x",
    pid: process.pid,
    cwd: "/",
    attest: {},
  },
});
c.request({ type: "list" }).then((r) => console.log(`reply:${r.type}`));
