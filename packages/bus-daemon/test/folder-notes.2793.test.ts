// #2793 S6: the daemon wires the folder map (S2) into its routing (S3): the
// default lookup is the folder map, namespaces read the home instance's own
// approvals, a session in an unmapped folder is told how to answer, and a
// changed repo suggestion is said once and moves nothing.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFolders } from "../src/folders.ts";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(stopAll);

const TOKEN_B = `oa_machine_${"b".repeat(28)}7f3a`;
const scratch = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));

function twoInstanceHome() {
  const home = scratch("ob-s6-home-");
  writeFileSync(
    join(home, "machine.json"),
    JSON.stringify({
      hub: "https://a.example.test",
      machine_id: "m",
      label: "l",
      machine_token: "oa_machine_SECRETSECRETSECRET",
    }),
    { mode: 0o600 },
  );
  mkdirSync(join(home, "instances"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(home, "instances", "b.json"),
    JSON.stringify({
      name: "b",
      hub: "https://b.example.test",
      machine_id: "",
      label: "l",
      machine_token: TOKEN_B,
    }),
    { mode: 0o600 },
  );
  return home;
}

const filesOf = async (
  h: Awaited<ReturnType<typeof daemonHarness>>,
  ref: string,
  cwd: string,
) => {
  const c = await h.adapter(ref, { cwd });
  const me = await c.request({ type: "self", row: true });
  return me.type === "agent" ? (me.agent?.config_files ?? []) : [];
};

describe("folder map wired into the daemon (#2793 S6)", () => {
  it("an unmapped folder's session is told to run use in that folder", async () => {
    const home = twoInstanceHome();
    const h = await daemonHarness({ instancesHome: home });
    const dir = scratch("ob-s6-u-");
    const client = await h.adapter("u1", { cwd: dir });
    expect(await client.request({ type: "self", row: true })).toMatchObject({
      type: "error",
      code: "hub_unavailable",
      message:
        "This folder is not connected to a bus instance. Run npx @open-artifacts/bus use in this folder.",
    });
    expect(h.daemon.agents.byRef("u1")?.instance).toBeUndefined();
  });

  it("a mapped folder gets no note; a changed suggestion is said once and moves nothing", async () => {
    const home = twoInstanceHome();
    const dir = scratch("ob-s6-m-");
    writeFolders({ map: { [dir]: "main" }, no: {}, seen: {} }, home);
    writeFileSync(
      join(dir, ".oa-bus.json"),
      JSON.stringify({ instance: "https://xn--80ak6aa92e.example.com" }),
      { mode: 0o600 },
    );
    const h = await daemonHarness({ instancesHome: home });
    const first = await filesOf(h, "m1", dir);
    expect(first).toEqual([
      expect.objectContaining({
        state: "noted",
        reason:
          "This repo now suggests https://xn--80ak6aa92e.example.com. Nothing changed: this folder keeps its answer.",
      }),
    ]);
    expect(h.daemon.agents.byRef("m1")?.instance).toBe("main");
    // Said once: the next session in the folder hears nothing.
    expect(await filesOf(h, "m2", dir)).toEqual([]);
  });

  it("a suggestion equal to the saved one is not news", async () => {
    const home = twoInstanceHome();
    const dir = scratch("ob-s6-s-");
    const addr = "https://same.example.com";
    writeFolders(
      { map: { [dir]: "main" }, no: {}, seen: { [dir]: addr } },
      home,
    );
    writeFileSync(
      join(dir, ".oa-bus.json"),
      JSON.stringify({ instance: addr }),
      { mode: 0o600 },
    );
    const h = await daemonHarness({ instancesHome: home });
    expect(await filesOf(h, "s1", dir)).toEqual([]);
  });

  it("a live session keeps its hub when an instance is added; only later sessions use the new map", async () => {
    // Main only: every folder is main.
    const home = scratch("ob-s6-add-");
    writeFileSync(
      join(home, "machine.json"),
      JSON.stringify({
        hub: "https://a.example.test",
        machine_id: "m",
        label: "l",
        machine_token: "oa_machine_SECRETSECRETSECRET",
      }),
      { mode: 0o600 },
    );
    const dir = scratch("ob-s6-live-");
    const h = await daemonHarness({ instancesHome: home });
    await h.adapter("early", { cwd: dir });
    expect(h.daemon.agents.byRef("early")?.instance).toBe("main");
    await h.next("agent_up");
    // `oa-bus add` completes: a second instance, the folder is unmapped.
    mkdirSync(join(home, "instances"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(home, "instances", "b.json"),
      JSON.stringify({
        name: "b",
        hub: "https://b.example.test",
        machine_id: "",
        label: "l",
        machine_token: TOKEN_B,
      }),
      { mode: 0o600 },
    );
    const late = await h.adapter("late", { cwd: dir });
    expect(h.daemon.agents.byRef("early")?.instance).toBe("main");
    expect(h.daemon.agents.byRef("early")?.live).toBe(true);
    expect(h.daemon.agents.byRef("late")?.instance).toBeUndefined();
    expect(await late.request({ type: "self", row: true })).toMatchObject({
      type: "error",
      code: "hub_unavailable",
    });
    await vi.waitFor(() => expect(h.daemon.hub.open).toBe(true));
  });

  it("namespace approval is read from the home instance's own file", async () => {
    const home = twoInstanceHome();
    const dir = scratch("ob-s6-ns-");
    writeFolders({ map: { [dir]: "b" }, no: {}, seen: {} }, home);
    writeFileSync(
      join(dir, ".oa-bus.json"),
      JSON.stringify({ namespace: "team" }),
      { mode: 0o600 },
    );
    // Approved for main only: no approval on b.
    writeFileSync(
      join(home, "namespaces.json"),
      JSON.stringify({ approved: [{ dir, namespace: "team" }] }),
      { mode: 0o600 },
    );
    const h = await daemonHarness({
      instancesHome: home,
      resolveNamespace: undefined as never,
    });
    await h.adapter("n1", { cwd: dir });
    expect(h.daemon.agents.byRef("n1")?.namespace).not.toBe("team");
    // Approved on b's own file: it counts.
    writeFileSync(
      join(home, "namespaces.b.json"),
      JSON.stringify({ approved: [{ dir, namespace: "team" }] }),
      { mode: 0o600 },
    );
    await h.adapter("n2", { cwd: dir });
    expect(h.daemon.agents.byRef("n2")?.namespace).toBe("team");
  });
});
