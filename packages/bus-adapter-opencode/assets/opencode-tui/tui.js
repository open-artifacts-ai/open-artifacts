// Open Artifacts bus OpenCode TUI plugin: publishes which root sessions this TUI has
// opened, so the daemon delivers to a session only while a TUI has it.
// Ported from agent-bus's opencode presence plugin; only the home changed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const POLL_MS = 500;

function setup(api) {
  try {
    const home = path.resolve(
      process.env.OA_BUS_HOME || path.join(os.homedir(), ".oa-bus"),
    );
    const dir = path.join(home, "opencode-tui");
    const file = path.join(dir, `${process.pid}.json`);
    const roots = new Set();

    const root = (id) => {
      const seen = new Set();
      while (typeof id === "string" && !seen.has(id)) {
        seen.add(id);
        const session = api.data.session.get(id);
        if (!session) return undefined;
        if (!session.parentID) return id;
        id = session.parentID;
      }
      return undefined;
    };

    // True once the file lists `ids`; false on any fs error, so the caller
    // records nothing and the next tick tries again.
    const write = (ids) => {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        const body = {
          pid: process.pid,
          sessionIDs: ids,
          updatedAt: new Date().toISOString(),
        };
        fs.writeFileSync(tmp, JSON.stringify(body));
        fs.renameSync(tmp, file);
        return true;
      } catch {
        return false;
      }
    };

    const tick = () => {
      try {
        const route = api.ui.router.current();
        if (route?.type !== "session") return;
        const id = root(route.sessionID);
        if (id && !roots.has(id) && write([...roots, id])) roots.add(id);
      } catch {}
    };

    process.once("exit", () => {
      try {
        fs.rmSync(file, { force: true });
      } catch {}
    });
    setInterval(tick, POLL_MS).unref?.();
  } catch {}
}

export default { id: "oa-bus.opencode.presence", setup };
