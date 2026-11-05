/**
 * MSW mock of the R.events socket (live version updates; ArtifactEvent frames).
 *
 *   const events = createArtifactEvents();
 *   server.use(...createHandlers({ events }), ...events.handlers);
 *   events.emitVersion(id, { version: 3, restoredFrom: 1 });
 *   events.emitGone(id); // { type: "gone", reason: "deleted" }, then close 4403
 *   events.emitGone(id, "changed"); // visibility, share, capabilities
 *
 * On connect a socket gets `{ type: "hello", version }` (the mock store's
 * currentVersion when wired through createHandlers({ events }), else 1).
 * Wired that way, mock publish/restore emit `version` frames and mock
 * delete/visibility/capabilities changes emit `gone`, as the server does.
 * Frames go to every socket of the artifact; by.name is sent as given (the
 * mock does not model viewer classes).
 */
import { type WebSocketHandler, ws } from "msw";
import {
  type ArtifactEvent,
  type ArtifactEventBy,
  EVENTS_GONE_CLOSE,
} from "../schemas.js";

type Client = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "close", cb: () => void): void;
};

export type ArtifactEventsMock = {
  /** Spread into setupServer/setupWorker next to createHandlers(). */
  handlers: WebSocketHandler[];
  /** Sends a `version` frame to every open socket of `id`. Returns how many. */
  emitVersion(
    id: string,
    e: {
      version: number;
      at?: string;
      by?: ArtifactEventBy;
      restoredFrom?: number;
    },
  ): number;
  /** Sends `{ type: "gone", reason }` and closes with 4403 every open socket of `id`. */
  emitGone(id: string, reason?: "deleted" | "changed"): number;
  /** Sends `{ type: "comments", open }` to every open socket of `id` (#682). */
  emitComments(id: string, open: number): number;
  /** Open sockets for `id`. */
  connections(id: string): number;
  /** Set by createHandlers({ events }): the version a hello reports. */
  currentVersion?: (id: string) => number | undefined;
};

export function createArtifactEvents(): ArtifactEventsMock {
  const clients = new Map<string, Set<Client>>();
  const link = ws.link("*/api/v1/artifacts/:id/events");
  const send = (c: Client, f: ArtifactEvent) => c.send(JSON.stringify(f));
  const mock: ArtifactEventsMock = {
    handlers: [
      link.addEventListener("connection", ({ client, params }) => {
        const id = String(params.id);
        const set = clients.get(id) ?? new Set<Client>();
        clients.set(id, set);
        const c = client as unknown as Client;
        set.add(c);
        c.addEventListener("close", () => set.delete(c));
        send(c, {
          type: "hello",
          version: mock.currentVersion?.(id) ?? 1,
        });
      }),
    ],
    emitVersion(id, e) {
      const set = clients.get(id) ?? new Set<Client>();
      const frame: ArtifactEvent = {
        type: "version",
        version: e.version,
        at: e.at ?? new Date().toISOString(),
        by: e.by ?? { kind: "user" },
        ...(e.restoredFrom === undefined
          ? {}
          : { restoredFrom: e.restoredFrom }),
      };
      for (const c of set) send(c, frame);
      return set.size;
    },
    emitGone(id, reason = "deleted") {
      const set = clients.get(id) ?? new Set<Client>();
      const n = set.size;
      for (const c of [...set]) {
        send(c, { type: "gone", reason });
        set.delete(c);
        // Next task: an immediate close would drop the queued gone frame.
        setTimeout(() => c.close(EVENTS_GONE_CLOSE, "gone"), 0);
      }
      return n;
    },
    emitComments(id, open) {
      const set = clients.get(id) ?? new Set<Client>();
      for (const c of set) send(c, { type: "comments", open });
      return set.size;
    },
    connections: (id) => clients.get(id)?.size ?? 0,
  };
  return mock;
}
