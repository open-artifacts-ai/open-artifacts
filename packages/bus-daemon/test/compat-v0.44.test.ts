// C23c: an adapter process from 0.44.x (a days-old session) talking to this
// daemon says hello without the IPC marker. Its strict decoder must take every
// reply while an omp agent is on the bus: omp is shown to it as pi.
import { connect } from "node:net";
import { CLIENT_VERSION, daemonStatus, LineDecoder } from "@oa/bus-ipc";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as V0441 from "./fixtures/ipc-v0.44.1.ts";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(stopAll);

const row = (bus_name: string, kind: string) => ({
  bus_name,
  kind,
  namespace: "ns",
  global: false,
  state: "live",
});

/** A daemon whose stub hub has an omp agent, a claude agent and a future kind in `ns`. */
async function busWithOmp() {
  const h = await daemonHarness({ claude: { syncMs: 3_600_000 } });
  h.hubSock()?.on("message", (d) => {
    const f = JSON.parse(String(d));
    if (f.type !== "list") return;
    const agents = [
      row("forker", "omp"),
      row("old", "claude-code"),
      row("later", "zeta"),
    ];
    h.hubSock()?.send(
      JSON.stringify({ v: 1, id: f.id, type: "roster", agents }),
    );
  });
  return h;
}

/** A raw IPC client: writes `frames` in order and returns every line the daemon wrote. */
function talk(
  path: string,
  frames: object[],
  want: number,
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const sock = connect(path);
    const decoder = new LineDecoder();
    const got: unknown[] = [];
    sock.once("error", reject);
    sock.once("connect", () => {
      for (const f of frames) sock.write(`${JSON.stringify(f)}\n`);
    });
    sock.on("data", (chunk) => {
      got.push(...decoder.push(chunk));
      if (got.length >= want) {
        sock.destroy();
        resolve(got);
      }
    });
  });
}

const helloOf = (agent_ref: string, kind: string, marker?: string) => ({
  v: 1,
  id: "hello",
  type: "hello",
  kind,
  agent_ref,
  pid: process.pid,
  cwd: "/w",
  proposed_name: agent_ref,
  attest: {},
  ...(marker ? { client_version: marker } : {}),
});
const ask = (id: string, type: string) => ({ v: 1, id, type });

describe("a 0.44.x adapter on a bus with omp (C23c)", () => {
  it("decodes list and self with omp shown as pi, the row kept", async () => {
    const h = await busWithOmp();
    // The omp agent is local here too, so self reports kind omp to its own adapter.
    await talk(h.socketPath, [helloOf("ses_omp", "omp", CLIENT_VERSION)], 1);
    const frames = await talk(
      h.socketPath,
      [helloOf("ses_old", "claude-code"), ask("l", "list"), ask("s", "self")],
      3,
    );
    const decoded = frames.map((f) => V0441.DaemonFrame.parse(f));
    const roster = decoded.find((f) => f.type === "roster");
    expect(roster?.agents.map((a) => [a.name, a.kind])).toEqual([
      ["forker", "pi"],
      ["old", "claude-code"],
      ["later", "pi"],
    ]);
    const self = decoded.find((f) => f.type === "agent");
    expect(self?.agent?.kind).toBe("claude-code");
  });

  it("decodes a marker-less status with omp shown as pi", async () => {
    const h = await busWithOmp();
    // omp, like pi, is live only while its connection is open (C23b).
    await h.adapter("ses_omp", { kind: "omp", client_version: CLIENT_VERSION });
    const [st] = await talk(
      h.socketPath,
      [{ v: 1, id: "status", type: "status" }],
      1,
    );
    const decoded = V0441.DaemonFrame.parse(st);
    expect(decoded.type).toBe("status");
    if (decoded.type !== "status") return;
    expect(decoded.namespaces[0]?.agents.map((a) => a.kind)).toEqual([
      "pi",
      "claude-code",
      "pi",
    ]);
  });

  it("control: the same roster without the rewrite fails the 0.44.1 decoder", async () => {
    const h = await busWithOmp();
    const frames = await talk(
      h.socketPath,
      [helloOf("ses_new", "claude-code", CLIENT_VERSION), ask("l", "list")],
      2,
    );
    const roster = frames[1];
    expect(V0441.DaemonFrame.safeParse(roster).success).toBe(false);
    expect(
      V0441.DaemonFrame.safeParse({
        ...(roster as object),
        agents: [
          {
            name: "x",
            namespace: "ns",
            kind: "omp",
            live: true,
            global: false,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("self: a new kind is pi without the marker, kept with it", async () => {
    const h = await busWithOmp();
    const selfOf = async (ref: string, marker?: string) => {
      const frames = await talk(
        h.socketPath,
        [helloOf(ref, "omp", marker), ask("s", "self")],
        2,
      );
      return frames[1] as { type: string; agent: { kind: string } };
    };
    const old = await selfOf("ses_a");
    expect(V0441.DaemonFrame.parse(old)).toMatchObject({
      type: "agent",
      agent: { kind: "pi" },
    });
    expect((await selfOf("ses_b", CLIENT_VERSION)).agent.kind).toBe("omp");
  });

  it("a marked hello sees the real kinds, omp included", async () => {
    const h = await busWithOmp();
    const frames = await talk(
      h.socketPath,
      [
        helloOf("ses_omp", "omp", CLIENT_VERSION),
        ask("l", "list"),
        ask("s", "self"),
      ],
      3,
    );
    const by = (t: string) =>
      frames.find((f) => (f as { type: string }).type === t) as {
        agents?: { kind: string }[];
        agent?: { kind: string };
      };
    expect(by("roster").agents?.map((a) => a.kind)).toEqual([
      "omp",
      "claude-code",
      "zeta",
    ]);
    expect(by("agent").agent?.kind).toBe("omp");
    // The CLI's status carries the marker too; an open omp session keeps the namespace listed.
    await h.adapter("ses_live", {
      kind: "omp",
      client_version: CLIENT_VERSION,
    });
    await vi.waitFor(async () => {
      const st = await daemonStatus({ path: h.socketPath, timeoutMs: 3000 });
      expect(st.namespaces[0]?.agents.map((a) => a.kind)).toEqual([
        "omp",
        "claude-code",
        "zeta",
      ]);
    });
  });
});

it("an old daemon takes a marked hello and status, dropping the marker", () => {
  const hello = V0441.AdapterFrame.parse(
    helloOf("ses_new", "claude-code", CLIENT_VERSION),
  );
  expect(hello).not.toHaveProperty("client_version");
  const st = V0441.StatusRequest.parse({
    v: 1,
    id: "status",
    type: "status",
    client_version: CLIENT_VERSION,
  });
  expect(st).not.toHaveProperty("client_version");
});
