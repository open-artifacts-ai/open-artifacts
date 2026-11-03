import { randomBytes } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

// WebSocket handshakes and raw-Host requests over node:http(s). fetch can't
// send Upgrade or a Host that differs from the URL. Both resolve to a
// Response (a 101 included), so crossCheck and expectRefused judge them like
// any other reply. A timeout or socket error rejects, never a refusal; under
// sendProbe it is tried once more, then infra.

const TIMEOUT_MS = 15_000;

function toResponse(res: IncomingMessage, body: Buffer): Response {
  const headers = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
  }
  const status = res.statusCode ?? 0;
  if (status >= 200 && status <= 599)
    return new Response(
      status === 204 || status === 304 ? null : new Uint8Array(body),
      {
        status,
        headers,
      },
    );
  // Response can't carry a 1xx: keep the real status on a bodiless one.
  const r = new Response(null, { status: 200, headers });
  Object.defineProperty(r, "status", { value: status });
  return r;
}

interface RawOpts {
  url: string;
  method?: string;
  headers: Headers;
  /** Sent as the Host header (and TLS SNI unless `servername`). */
  host?: string;
  servername?: string;
  timeoutMs?: number;
}

/** One request over node:http(s); the reply (any status) as a Response. */
export function rawRequest(o: RawOpts): Promise<Response> {
  const u = new URL(o.url);
  const headers: Record<string, string> = {};
  o.headers.forEach((v, k) => {
    headers[k] = v;
  });
  if (o.host) headers.host = o.host;
  const tls = u.protocol === "https:";
  const req = (tls ? httpsRequest : httpRequest)({
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (tls ? 443 : 80),
    path: `${u.pathname}${u.search}`,
    method: o.method ?? "GET",
    headers,
    ...(tls
      ? {
          servername: o.servername ?? (o.host ?? u.hostname).split(":")[0],
        }
      : {}),
    agent: false,
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      // Named TimeoutError so sendProbe reads it as no response (infra).
      const e = new Error(`timed out after ${o.timeoutMs ?? TIMEOUT_MS} ms`);
      e.name = "TimeoutError";
      reject(e);
    }, o.timeoutMs ?? TIMEOUT_MS);
    const done = (r: Response) => {
      clearTimeout(timer);
      resolve(r);
    };
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      done(toResponse(res, Buffer.alloc(0)));
    });
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => done(toResponse(res, Buffer.concat(chunks))));
      res.on("error", () => {
        clearTimeout(timer);
        // A response came: no code, so it is never read as no response and
        // never retried (a retry's answer must not replace this one).
        reject(new Error(`body failed after status ${res.statusCode ?? "?"}`));
      });
    });
    req.on("error", (e) => {
      clearTimeout(timer);
      // Never the message: it can carry the URL. The code is enough, and it
      // stays on the error so sendProbe can tell no response (ECONNRESET, ...)
      // from a verdict: one retry, then infra.
      const code = (e as { code?: string }).code;
      reject(
        Object.assign(new Error(`request failed (${code ?? "?"})`), { code }),
      );
    });
    req.end();
  });
}

const upgradeHeaders = (req: Request): Headers => {
  const headers = new Headers(req.headers);
  headers.set("connection", "Upgrade");
  headers.set("upgrade", "websocket");
  headers.set("sec-websocket-version", "13");
  headers.set("sec-websocket-key", randomBytes(16).toString("base64"));
  return headers;
};

/**
 * The WebSocket handshake for `req` (its URL and headers, plus Upgrade). 101
 * when the server upgraded; the socket is closed straight away.
 */
export function wsHandshake(req: Request): Promise<Response> {
  return rawRequest({ url: req.url, headers: upgradeHeaders(req) });
}

/** A WebSocket kept open after its 101, watched for the server's close. */
export interface OpenSocket {
  /**
   * Null while open. Once the server closed it: the close frame's code, or
   * null when the connection ended without one.
   */
  readonly closed: { code: number | null } | null;
  /** Closes it from this side (idempotent). */
  close(): void;
}

/**
 * The WebSocket handshake for `req`, kept open on a 101 (`socket`); any other
 * answer is returned as a Response with no socket. The socket reads server
 * frames only to see a close frame and to answer pings (a ping left
 * unanswered could close it for a reason of its own). It never sends data.
 */
export function wsOpen(
  req: Request,
  timeoutMs = TIMEOUT_MS,
): Promise<{ res: Response; socket?: OpenSocket }> {
  const u = new URL(req.url);
  const headers: Record<string, string> = {};
  upgradeHeaders(req).forEach((v, k) => {
    headers[k] = v;
  });
  const tls = u.protocol === "https:";
  const r = (tls ? httpsRequest : httpRequest)({
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (tls ? 443 : 80),
    path: `${u.pathname}${u.search}`,
    method: "GET",
    headers,
    agent: false,
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      r.destroy();
      const e = new Error(`timed out after ${timeoutMs} ms`);
      e.name = "TimeoutError";
      reject(e);
    }, timeoutMs);
    r.on("upgrade", (res, sock, head: Buffer) => {
      clearTimeout(timer);
      const s: { closed: { code: number | null } | null; close(): void } = {
        closed: null,
        close: () => sock.destroy(),
      };
      const end = (code: number | null) => {
        s.closed ??= { code };
      };
      let buf = Buffer.alloc(0);
      const feed = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (buf.length < 2) return;
          const op = (buf[0] as number) & 0x0f;
          let len = (buf[1] as number) & 0x7f;
          let off = 2;
          if (len === 126) {
            if (buf.length < 4) return;
            len = buf.readUInt16BE(2);
            off = 4;
          } else if (len === 127) {
            if (buf.length < 10) return;
            len = Number(buf.readBigUInt64BE(2));
            off = 10;
          }
          if ((buf[1] as number) & 0x80) off += 4;
          if (buf.length < off + len) return;
          const payload = buf.subarray(off, off + len);
          buf = buf.subarray(off + len);
          if (op === 0x8) end(len >= 2 ? payload.readUInt16BE(0) : null);
          else if (op === 0x9 && !s.closed && len <= 125) {
            // A pong carries the ping's payload, masked (RFC 6455 5.5.3).
            const mask = randomBytes(4);
            const out = Buffer.alloc(len);
            for (let i = 0; i < len; i++)
              out[i] = (payload[i] as number) ^ (mask[i % 4] as number);
            sock.write(
              Buffer.concat([Buffer.from([0x8a, 0x80 | len]), mask, out]),
            );
          }
        }
      };
      sock.on("data", feed);
      sock.on("end", () => end(null));
      sock.on("close", () => end(null));
      sock.on("error", () => end(null));
      if (head.length) feed(head);
      resolve({ res: toResponse(res, Buffer.alloc(0)), socket: s });
    });
    r.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        clearTimeout(timer);
        resolve({ res: toResponse(res, Buffer.concat(chunks)) });
      });
      res.on("error", () => {
        clearTimeout(timer);
        reject(new Error(`body failed after status ${res.statusCode ?? "?"}`));
      });
    });
    r.on("error", (e) => {
      clearTimeout(timer);
      const code = (e as { code?: string }).code;
      reject(
        Object.assign(new Error(`request failed (${code ?? "?"})`), { code }),
      );
    });
    r.end();
  });
}
