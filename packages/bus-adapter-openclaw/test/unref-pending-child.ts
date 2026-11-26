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
const answered = c
  .request({ type: "list" })
  .then((r) => console.log(`reply:${r.type}`));
// While the request is pending the socket must hold the loop: a handle that
// is ref'd shows here, an unref'd one does not.
console.log(
  `held:${process.getActiveResourcesInfo().some((r) => /Pipe|TCP/.test(r))}`,
);
void answered;
