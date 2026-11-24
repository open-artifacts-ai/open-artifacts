// #3028: a session that ends while the daemon is down must still leave the
// hub. The daemon keeps the refs it announced in announced.json, and the
// first thing a restarted daemon does is report the ones it can no longer see
// as closed, so a row is never left live (and holding its name) after its
// session is gone. One session, one entry: the ghost's name is then free for
// a rename (the hub hands it back through the away row, #1742).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(async () => {
  await stopAll();
});

const session = (dir: string, ref: string, pid = 4242) =>
  writeFileSync(
    join(dir, `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId: ref,
      procStart: "t0",
      name: "laptop",
      messagingSocketPath: "",
      cwd: "/repo",
    }),
  );

/** The `sessions` frame the daemon sends right after its hello. */
const firstSessions = (h: Awaited<ReturnType<typeof daemonHarness>>) =>
  h.next("sessions");

const claude = (sessionsDir: string, over = {}) => ({
  sessionsDir,
  socketsDir: join(sessionsDir, "r"),
  syncMs: 20,
  procStart: () => "t0",
  isRunning: () => true,
  ...over,
});

describe("a session that ended while the daemon was down leaves (#3028)", () => {
  it("the restarted daemon reports it closed, and keeps the live ones open", async () => {
    const state = mkdtempSync(join(tmpdir(), "ob-3028-"));
    const announcedFile = join(state, "announced.json");
    // The previous run had announced two sessions; only one is still there.
    writeFileSync(
      announcedFile,
      JSON.stringify({
        v: 1,
        refs: [
          { ref: "gone-session", kind: "claude-code" },
          { ref: "live-session", kind: "claude-code" },
        ],
      }),
      // The daemon writes it 0600, and a file others can write is ignored.
      { mode: 0o600 },
    );
    const sessions = mkdtempSync(join(tmpdir(), "ob-3028-s-"));
    session(sessions, "live-session");
    const h = await daemonHarness({
      announcedFile,
      claude: claude(sessions),
    });
    const frame = await firstSessions(h);
    // The session whose file is gone left with its process: the hub closes it,
    // so its name stops being a live holder.
    expect(frame.closed).toContain("gone-session");
    // A live session is never closed and reopened on every restart.
    expect(frame.closed).not.toContain("live-session");
    expect(frame.open).toContain("live-session");
  });

  it("a session live in one run and gone in the next is closed by the restarted daemon", async () => {
    const state = mkdtempSync(join(tmpdir(), "ob-3028-r-"));
    const announcedFile = join(state, "announced.json");
    const sessions = mkdtempSync(join(tmpdir(), "ob-3028-rs-"));
    session(sessions, "ended-session");
    const first = await daemonHarness({ announcedFile, claude: claude(sessions) });
    await first.next("agent_up");
    await vi.waitFor(async () => {
      const { readAnnounced } = await import("../src/announced.ts");
      expect(readAnnounced(announcedFile).map((e) => e.ref)).toContain(
        "ended-session",
      );
    });
    await stopAll();
    // The session ended while the daemon was down: its file is gone.
    rmSync(join(sessions, "4242.json"));
    const second = await daemonHarness({ announcedFile, claude: claude(sessions) });
    const frame = await firstSessions(second);
    expect(frame.closed).toContain("ended-session");
    expect(frame.open).toEqual([]);
  });

  it("a ref it announced itself is written to announced.json, for the next run", async () => {
    const state = mkdtempSync(join(tmpdir(), "ob-3028-w-"));
    const announcedFile = join(state, "announced.json");
    const sessions = mkdtempSync(join(tmpdir(), "ob-3028-ws-"));
    session(sessions, "this-run");
    const h = await daemonHarness({ announcedFile, claude: claude(sessions) });
    await h.next("agent_up");
    await vi.waitFor(async () => {
      const { readAnnounced } = await import("../src/announced.ts");
      expect(readAnnounced(announcedFile).map((e) => e.ref)).toContain(
        "this-run",
      );
    });
  });
});
