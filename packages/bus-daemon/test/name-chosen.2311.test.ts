// #2311: a session the user named says so on agent_up, even when it was live
// before hello_ok told the daemon the hub takes name_chosen; a re-derived
// Claude title is a rename that does not mark the name chosen.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUS_CAPS } from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(stopAll);

const write = (d: string, over: object = {}) =>
  writeFileSync(
    join(d, "4242.json"),
    JSON.stringify({
      pid: 4242,
      sessionId: "s-a",
      procStart: "t0",
      name: "pi-2",
      nameSource: "user",
      entrypoint: "cli",
      messagingSocketPath: "",
      cwd: "/repo",
      ...over,
    }),
  );

async function start(over: object = {}) {
  const d = mkdtempSync(join(tmpdir(), "ob-chosen-"));
  write(d, over);
  const h = await daemonHarness({
    claude: {
      sessionsDir: d,
      socketsDir: join(d, "r"),
      syncMs: 20,
      procStart: () => "t0",
      isRunning: () => true,
    },
  });
  return { h, d };
}
const helloOk = (caps: string[]) => ({
  id: "w",
  type: "hello_ok" as const,
  machine_id: "1".repeat(16),
  machine_label: "laptop",
  server_version: "1",
  caps,
});
const settle = () => new Promise((r) => setTimeout(r, 150));

describe("name_chosen (#2311)", () => {
  it("is sent after hello_ok for a session already live at connect", async () => {
    const { h } = await start();
    await vi.waitFor(() =>
      expect(h.of("agent_up").some((u) => u.agent_ref === "s-a")).toBe(true),
    );
    expect(h.of("agent_up").some((u) => "name_chosen" in u)).toBe(false);
    h.toDaemon(helloOk([BUS_CAPS.ids, BUS_CAPS.mailbox, BUS_CAPS.nameChosen]));
    await vi.waitFor(() =>
      expect(
        h
          .of("agent_up")
          .some((u) => u.agent_ref === "s-a" && u.name_chosen === true),
      ).toBe(true),
    );
  });

  it("is not sent to a hub that did not list the cap, nor for a derived name", async () => {
    const { h } = await start();
    h.toDaemon(helloOk([BUS_CAPS.ids, BUS_CAPS.mailbox]));
    await settle();
    expect(h.of("agent_up").some((u) => "name_chosen" in u)).toBe(false);
    const g = await start({ nameSource: "derived" });
    g.h.toDaemon(helloOk([BUS_CAPS.nameChosen]));
    await settle();
    expect(g.h.of("agent_up").some((u) => "name_chosen" in u)).toBe(false);
  });

  it("a re-derived title renames with name_chosen false", async () => {
    const { h, d } = await start({ nameSource: "derived", name: "first" });
    h.toDaemon(helloOk([BUS_CAPS.ids, BUS_CAPS.mailbox, BUS_CAPS.nameChosen]));
    await settle();
    write(d, { nameSource: "derived", name: "second title" });
    await vi.waitFor(() => expect(h.of("rename").length).toBeGreaterThan(0));
    expect(h.of("rename").at(-1)).toMatchObject({
      proposed_name: "second title",
      name_chosen: false,
    });
    write(d, { nameSource: "user", name: "third" });
    await vi.waitFor(() =>
      expect(h.of("rename").at(-1)).toMatchObject({
        proposed_name: "third",
        name_chosen: true,
      }),
    );
  });
});
