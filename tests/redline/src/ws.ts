import { randomBytes } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

// WebSocket handshakes and raw-Host requests over node:http(s). fetch can't
// send Upgrade or a Host that differs from the URL. Both resolve to a
// Response (a 101 included), so crossCheck and expectRefused judge them like
// any other reply. A timeout or socket error rejects: a FAIL, never a refusal.

const TIMEOUT_MS = 15_000;

function toResponse(res: IncomingMessage, body: Buffer): Response {
  const headers = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
  }
  const status = res.statusCode ?? 0;
  if (status >= 200 && status <= 599)
    return new Response(status === 204 || status === 304 ? null : body, {
      status,
      headers,
    });
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
      reject(new Error(`timed out after ${o.timeoutMs ?? TIMEOUT_MS} ms`));
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
      res.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    req.on("error", (e) => {
      clearTimeout(timer);
      // Never the message: it can carry the URL. The code is enough.
      reject(
        new Error(`request failed (${(e as { code?: string }).code ?? "?"})`),
      );
    });
    req.end();
  });
}

/**
 * The WebSocket handshake for `req` (its URL and headers, plus Upgrade). 101
 * when the server upgraded; the socket is closed straight away.
 */
export function wsHandshake(req: Request): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.set("connection", "Upgrade");
  headers.set("upgrade", "websocket");
  headers.set("sec-websocket-version", "13");
  headers.set("sec-websocket-key", randomBytes(16).toString("base64"));
  return rawRequest({ url: req.url, headers });
}
