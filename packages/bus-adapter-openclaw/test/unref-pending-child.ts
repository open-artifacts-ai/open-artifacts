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
// Whether a handle other than stdio still holds the loop. (getActiveResourcesInfo
// lists unref'd handles too, so it cannot tell; the handle's own hasRef can.)
const stdio = new Set<unknown>([process.stdin, process.stdout, process.stderr]);
const held = () =>
  `held:${(
    process as unknown as {
      _getActiveHandles: () => { _handle?: { hasRef?: () => boolean } }[];
    }
  )
    ._getActiveHandles()
    .some((h) => !stdio.has(h) && h._handle?.hasRef?.() === true)}`;
const answered = c.request({ type: "list" }).then((r) => {
  console.log(`reply:${r.type}`);
  // Answered and nothing else to do: the socket must no longer hold the loop,
  // so the process exits by itself.
  console.log(held());
});
// While the request is pending the socket must hold the loop: a handle that
// is ref'd shows here, an unref'd one does not.
console.log(held());
void answered;
