// A /clear in Claude Code (#1295): the same process reports a new session id.
// The daemon tells a mailbox hub the new ref replaces the old one, so the
// address and its mail carry over; a session in another process, or a hub
// without the cap, never gets `replaces`.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUS_CAPS } from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(stopAll);

const write = (d: string, pid: number, sessionId: string, name: string) =>
  writeFileSync(
    join(d, `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId,
      procStart: "t0",
      name,
      messagingSocketPath: "",
      cwd: "/repo",
    }),
  );

type Harness = Awaited<ReturnType<typeof daemonHarness>>;
/** The agent_up the daemon sent for `ref`, once it has. */
const upFor = async (h: Harness, ref: string) => {
  await vi.waitFor(() =>
    expect(h.of("agent_up").some((u) => u.agent_ref === ref)).toBe(true),
  );
  return h
    .of("agent_up")
    .filter((u) => u.agent_ref === ref)
    .at(-1) as Extract<ReturnType<Harness["of"]>[number], { type: "agent_up" }>;
};

async function start(hubCaps: string[] | undefined) {
  const d = mkdtempSync(join(tmpdir(), "ob-clear-"));
  write(d, 4242, "s-old", "npm-test");
  const h = await daemonHarness({
    claude: {
      sessionsDir: d,
      socketsDir: join(d, "r"),
      syncMs: 20,
      procStart: () => "t0",
      isRunning: () => true,
    },
  });
  h.toDaemon({
    id: "w",
    type: "hello_ok",
    machine_id: "1".repeat(16),
    machine_label: "laptop",
    server_version: "1",
    ...(hubCaps === undefined ? {} : { caps: hubCaps }),
  });
  await upFor(h, "s-old");
  return { h, d };
}

describe("/clear handover in the daemon", () => {
  it("says hello with the ids and mailbox caps", async () => {
    const { h } = await start(undefined);
    expect(h.of("hello")[0]?.caps).toEqual([BUS_CAPS.ids, BUS_CAPS.mailbox]);
  });

  it("same pid, new session id: agent_up replaces the old ref and keeps its name", async () => {
    const { h, d } = await start([BUS_CAPS.ids, BUS_CAPS.mailbox]);
    write(d, 4242, "s-new", "fresh-name");
    const up = await upFor(h, "s-new");
    expect(up).toMatchObject({
      agent_ref: "s-new",
      replaces: "s-old",
      proposed_name: "npm-test",
    });
  });

  it("a different pid is another agent: no replaces", async () => {
    const { h, d } = await start([BUS_CAPS.ids, BUS_CAPS.mailbox]);
    write(d, 5555, "s-other", "other");
    const up = await upFor(h, "s-other");
    expect(up).toMatchObject({ agent_ref: "s-other", proposed_name: "other" });
    expect(up).not.toHaveProperty("replaces");
  });

  it("a hub that did not list mailbox never sees replaces", async () => {
    const { h, d } = await start([BUS_CAPS.ids]);
    write(d, 4242, "s-new", "npm-test");
    const up = await upFor(h, "s-new");
    expect(up).toMatchObject({ agent_ref: "s-new" });
    expect(up).not.toHaveProperty("replaces");
  });
});
