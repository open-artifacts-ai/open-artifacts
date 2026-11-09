// A renamed Codex session shows its name (#1748): the thread's name in
// `session_index.jsonl` is the bus name; the file only, in a temp home.
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUS_CAPS } from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODEX_INDEX_MAX_BYTES, codexThreadNames } from "../src/codex-names.ts";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(stopAll);

const THREAD = "019a0000-0000-7000-8000-000000000001";
const OTHER = "019a0000-0000-7000-8000-000000000002";
const entry = (id: string, thread_name: unknown, updated_at = "t") =>
  `${JSON.stringify({ id, thread_name, updated_at })}\n`;
const homeDir = () => mkdtempSync(join(tmpdir(), "ob-cxn-"));
const indexOf = (home: string) => join(home, "session_index.jsonl");

describe("codexThreadNames", () => {
  it("the latest entry for an id wins, and others are kept", () => {
    const home = homeDir();
    writeFileSync(
      indexOf(home),
      entry(THREAD, "first") + entry(OTHER, "other") + entry(THREAD, "second"),
    );
    const names = codexThreadNames(home);
    expect(names.get(THREAD)).toBe("second");
    expect(names.get(OTHER)).toBe("other");
  });

  it("a missing file or a missing home is no names, not an error", () => {
    const home = homeDir();
    expect(codexThreadNames(home).size).toBe(0);
    rmSync(home, { recursive: true });
    expect(codexThreadNames(home).size).toBe(0);
  });

  it("an older Codex with a directory or no index is no names", () => {
    const home = homeDir();
    mkdirSync(indexOf(home));
    expect(codexThreadNames(home).size).toBe(0);
  });

  it("skips bad, partial and nameless lines", () => {
    const home = homeDir();
    writeFileSync(
      indexOf(home),
      `not json\n[1]\nnull\n${entry(THREAD, "kept")}${entry(OTHER, 7)}{"id":"x","thread_na`,
    );
    const names = codexThreadNames(home);
    expect(names.get(THREAD)).toBe("kept");
    expect(names.has(OTHER)).toBe(false);
    expect(names.size).toBe(1);
  });

  it("reads only the last 1 MB, dropping the cut first line", () => {
    const home = homeDir();
    const pad = entry("pad", "p".repeat(900)).repeat(
      Math.ceil((CODEX_INDEX_MAX_BYTES * 2) / 900),
    );
    // Old entries sit before the window; the newest sit at the end.
    writeFileSync(
      indexOf(home),
      entry(OTHER, "old") + pad + entry(THREAD, "new"),
    );
    const names = codexThreadNames(home);
    expect(names.get(THREAD)).toBe("new");
    expect(names.has(OTHER)).toBe(false);
  });

  it("a later entry with no name clears the name", () => {
    const home = homeDir();
    writeFileSync(indexOf(home), entry(THREAD, "x") + entry(THREAD, ""));
    expect(codexThreadNames(home).has(THREAD)).toBe(false);
  });
});

async function start(home: string, over: { named?: string } = {}) {
  if (over.named !== undefined)
    writeFileSync(indexOf(home), entry(THREAD, over.named));
  const h = await daemonHarness({
    codex: { home } as never,
    claude: { syncMs: 20 } as never,
  });
  h.toDaemon({
    id: "w",
    type: "hello_ok",
    machine_id: "1".repeat(16),
    machine_label: "laptop",
    server_version: "1",
    caps: [BUS_CAPS.ids, BUS_CAPS.mailbox],
  });
  return h;
}
const hello = {
  kind: "codex" as const,
  cwd: "/repo",
  proposed_name: "codex",
};

describe("Codex thread names on the bus (#1748)", () => {
  it("a thread named at start registers under its name", async () => {
    const h = await start(homeDir(), { named: "Billing work" });
    await h.adapter(THREAD, hello);
    const up = await h.next("agent_up");
    expect(up).toMatchObject({
      agent_ref: THREAD,
      kind: "codex",
      proposed_name: "Billing work",
    });
    expect(h.of("rename")).toHaveLength(0);
  });

  it("an unnamed thread stays `codex`, with no rename", async () => {
    const home = homeDir();
    const h = await start(home);
    await h.adapter(THREAD, hello);
    expect((await h.next("agent_up")).proposed_name).toBe("codex");
    // A second thread's name shows once a tick has read the index; that
    // tick also saw this thread, which has no name, so it sent nothing.
    await h.adapter(OTHER, hello);
    writeFileSync(indexOf(home), entry(OTHER, "Sentinel"));
    await vi.waitFor(() =>
      expect(h.of("rename").map((r) => r.agent_ref)).toEqual([OTHER]),
    );
  });

  it("a rename while connected sends one rename frame, chosen", async () => {
    const home = homeDir();
    const h = await start(home);
    await h.adapter(THREAD, hello);
    await h.next("agent_up");
    writeFileSync(indexOf(home), entry(THREAD, "Release prep"));
    const r = await h.next("rename");
    expect(r).toMatchObject({
      agent_ref: THREAD,
      proposed_name: "Release prep",
      name_kind: "chosen",
    });
    // The latest entry wins: a second rename goes as a second frame.
    appendFileSync(indexOf(home), entry(THREAD, "Release prep 2"));
    await vi.waitFor(() => expect(h.of("rename")).toHaveLength(2));
    expect(h.of("rename")[1]?.proposed_name).toBe("Release prep 2");
    // No loop: the hub's answer is not a change.
    h.toDaemon({
      v: 1,
      id: r.id,
      type: "renamed",
      agent_ref: THREAD,
      bus_name: "Release-prep-2",
    });
    await vi.waitFor(() => expect(h.daemon.agents.byRef(THREAD)).toBeTruthy());
    expect(h.of("rename")).toHaveLength(2);
  });

  it("a name from a corrupt or oversized index is ignored", async () => {
    const home = homeDir();
    const h = await start(home);
    await h.adapter(THREAD, hello);
    await h.next("agent_up");
    writeFileSync(indexOf(home), `${"x".repeat(CODEX_INDEX_MAX_BYTES * 2)}\n`);
    appendFileSync(indexOf(home), entry(THREAD, "After junk"));
    await h.next("rename");
    expect(h.of("rename")[0]?.proposed_name).toBe("After junk");
  });

  it("a reconnect picks up a name given while the adapter was away", async () => {
    const home = homeDir();
    const h = await start(home);
    const c = await h.adapter(THREAD, hello);
    await h.next("agent_up");
    c.close();
    writeFileSync(indexOf(home), entry(THREAD, "Back again"));
    await h.adapter(THREAD, hello);
    const r = await h.next("rename");
    expect(r.proposed_name).toBe("Back again");
    expect(h.of("rename")).toHaveLength(1);
  });

  it("a registered name reaches the hub fitted to 64 characters", async () => {
    const h = await start(homeDir(), { named: "n".repeat(200) });
    await h.adapter(THREAD, hello);
    expect((await h.next("agent_up")).proposed_name.length).toBeLessThanOrEqual(
      64,
    );
  });
});
