import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { steerCodex } from "../src/transports/codex-steer.ts";

describe.skipIf(process.platform === "win32")(
  "steering through the local Codex control socket",
  () => {
    it.each(["active", "idle", "finished", "disconnect"] as const)(
      "handles %s",
      async (mode) => {
        const home = mkdtempSync(join(tmpdir(), "ob-st-"));
        const dir = join(home, "app-server-control");
        mkdirSync(dir, { mode: 0o700 });
        const path = join(home, "s");
        symlinkSync(path, join(dir, "app-server-control.sock"));
        const server = createServer();
        const rpc = new WebSocketServer({ server });
        const calls: { method: string; params?: unknown }[] = [];
        rpc.on("connection", (ws) =>
          ws.on("message", (raw) => {
            const m = JSON.parse(raw.toString());
            calls.push(m);
            const result = (value: unknown) =>
              ws.send(JSON.stringify({ id: m.id, result: value }));
            if (m.method === "initialize") result({});
            if (m.method === "thread/turns/list")
              result({
                data: [
                  {
                    id: "turn-A",
                    status: mode === "idle" ? "completed" : "inProgress",
                  },
                ],
              });
            if (m.method === "turn/steer") {
              if (mode === "disconnect") ws.terminate();
              else if (mode === "finished")
                ws.send(JSON.stringify({ id: m.id, error: { code: -32600 } }));
              else result({ turnId: "turn-A" });
            }
          }),
        );
        await new Promise<void>((resolve, reject) =>
          server.once("error", reject).listen(path, resolve),
        );
        try {
          const result = await steerCodex(home, "thread-A", "[oa-bus] message");
          expect(result).toBe(
            mode === "active"
              ? "accepted"
              : mode === "disconnect"
                ? "uncertain"
                : "fallback",
          );
          const steer = calls.filter((c) => c.method === "turn/steer");
          if (mode === "idle") expect(steer).toEqual([]);
          else
            expect(steer.map((c) => c.params)).toEqual([
              {
                threadId: "thread-A",
                expectedTurnId: "turn-A",
                input: [{ type: "text", text: "[oa-bus] message" }],
              },
            ]);
        } finally {
          rpc.close();
          await new Promise<void>((r) => server.close(() => r()));
        }
      },
    );
  },
);
