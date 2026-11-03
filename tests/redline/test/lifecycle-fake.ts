import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import { json } from "./fake.ts";

// #1137: a fake tenant for P13's seed and the lifecycle re-reads (rl-p, and
// rl-b as crossCheck's A side): artifacts, shares, members, the session hook
// and the events socket, as apps/server answers them. A local HTTP server, so
// src/lifecycle.ts reaches it with real fetch and a real WebSocket upgrade.

/** The R26 hook key the fake API seals for every install. */
export const FAKE_HOOK_KEY = "h".repeat(43);

interface Art {
  title: string;
  format: string;
  visibility: string;
  content: string;
  shares: Map<string, string>;
}

export interface LifeTenant {
  origin: string;
  artifacts: Map<string, Art>;
  /** email -> role */
  members: Map<string, string>;
  /** Open events sockets. */
  sockets: Set<Duplex>;
  /** Fault: another install's PAT reads this install's artifacts. */
  foreignReads: boolean;
  /** Fault: a socket is closed (1001) right after its 101. */
  closeOnOpen: boolean;
  /** Every request, as "METHOD path". */
  log: string[];
  /** Sends each open socket a close frame with `code`, then ends it. */
  closeSockets(code: number): void;
  close(): Promise<void>;
}

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const closeFrame = (code: number) =>
  Buffer.from([0x88, 0x02, (code >> 8) & 0xff, code & 0xff]);

/**
 * `pat(token)`: "own" for a live PAT of this install, "foreign" for one of
 * another install, null otherwise.
 */
export async function lifeTenant(
  pat: (token: string) => "own" | "foreign" | null,
): Promise<LifeTenant> {
  let n = 0;
  const t: LifeTenant = {
    origin: "",
    artifacts: new Map(),
    members: new Map([["redline-admin@x", "admin"]]),
    sockets: new Set(),
    foreignReads: false,
    closeOnOpen: false,
    log: [],
    closeSockets: (code) => {
      for (const s of t.sockets) {
        s.write(closeFrame(code));
        s.end();
      }
      t.sockets.clear();
    },
    close: async () => {},
  };
  const who = (q: IncomingMessage) => {
    const a = q.headers.authorization ?? "";
    return a.startsWith("Bearer ") ? pat(a.slice(7)) : null;
  };
  const handle = (q: IncomingMessage, r: ServerResponse, body: string) => {
    const url = new URL(q.url ?? "/", "http://x");
    const path = url.pathname;
    const method = q.method ?? "GET";
    t.log.push(`${method} ${path}`);
    if (path === "/__test/session" && method === "POST") {
      if (q.headers.authorization !== `Bearer ${FAKE_HOOK_KEY}`)
        return json(r, 404, { error: { code: "not_found" } });
      const b = JSON.parse(body) as { email: string; role: string };
      t.members.set(b.email, b.role);
      return json(r, 200, { cookie: "session" });
    }
    const caller = who(q);
    if (!caller) return json(r, 401, { error: { code: "unauthenticated" } });
    const own = caller === "own";
    if (path === "/api/v1/members" && method === "GET") {
      if (!own) return json(r, 404, { error: { code: "not_found" } });
      return json(
        r,
        200,
        [...t.members].map(([email, role], i) => ({
          id: `u${i}`,
          email,
          role,
        })),
      );
    }
    if (path === "/api/v1/artifacts" && method === "POST") {
      if (!own) return json(r, 404, { error: { code: "not_found" } });
      const b = JSON.parse(body) as Partial<Art>;
      const id = `art${++n}`;
      t.artifacts.set(id, {
        title: String(b.title),
        format: String(b.format),
        visibility: b.visibility ?? "private",
        content: String(b.content),
        shares: new Map(),
      });
      return json(r, 201, { id, version: 1, url: `${t.origin}/a/${id}` });
    }
    const m = path.match(/^\/api\/v1\/artifacts\/([^/]+)(\/.*)?$/);
    const a = m ? t.artifacts.get(m[1] as string) : undefined;
    const rest = m?.[2] ?? "";
    const readable = own || (t.foreignReads && method === "GET");
    if (!m || !a || !readable)
      return json(r, 404, { error: { code: "not_found" } });
    if (rest === "" && method === "GET")
      return json(r, 200, {
        id: m[1],
        title: a.title,
        description: null,
        format: a.format,
        visibility: a.visibility,
        owner: { id: "u0" },
        currentVersion: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        // Moves on every read: the re-read must not compare it.
        updatedAt: new Date(Date.now() + n++).toISOString(),
        deletedAt: null,
        thumbnailUrl: null,
      });
    if (rest === "" && method === "DELETE") {
      t.artifacts.delete(m[1] as string);
      return r.writeHead(204).end();
    }
    if (rest === "/versions/1/files/README.md" && method === "GET")
      return r
        .writeHead(200, { "content-type": "text/markdown" })
        .end(a.content);
    if (rest === "/shares" && method === "PUT") {
      const b = JSON.parse(body) as { email: string; role: string };
      a.shares.set(b.email, b.role);
      return json(r, 200, { ...b, createdAt: "x", emailed: false });
    }
    if (rest === "/shares" && method === "GET")
      return json(
        r,
        200,
        [...a.shares].map(([email, role]) => ({ email, role, createdAt: "x" })),
      );
    return json(r, 404, { error: { code: "not_found" } });
  };
  const server = createServer((q, r) => {
    let body = "";
    q.on("data", (c) => {
      body += c;
    });
    q.on("end", () => handle(q, r, body));
  });
  server.on("upgrade", (q: IncomingMessage, sock: Duplex) => {
    const path = new URL(q.url ?? "/", "http://x").pathname;
    t.log.push(`UPGRADE ${path}`);
    const m = path.match(/^\/api\/v1\/artifacts\/([^/]+)\/events$/);
    if (!m || !t.artifacts.has(m[1] as string) || who(q) !== "own") {
      sock.end("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    const accept = createHash("sha1")
      .update(`${q.headers["sec-websocket-key"]}${WS_GUID}`)
      .digest("base64");
    const head = Buffer.from(
      `HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`,
    );
    sock.on("error", () => {});
    sock.on("close", () => t.sockets.delete(sock));
    if (t.closeOnOpen) {
      // One write: the close arrives with the 101.
      sock.end(Buffer.concat([head, closeFrame(1001)]));
      return;
    }
    sock.write(head);
    t.sockets.add(sock);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  t.origin = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  t.close = () =>
    new Promise((r) => {
      for (const s of t.sockets) s.destroy();
      t.sockets.clear();
      server.closeAllConnections();
      server.close(() => r());
    });
  return t;
}
