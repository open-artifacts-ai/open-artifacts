import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A programmable local HTTP server: one per fake install.

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
) => void;

export interface Fake {
  origin: string;
  handle: Handler;
  close(): Promise<void>;
}

export async function fakeServer(handle?: Handler): Promise<Fake> {
  const f: Fake = {
    origin: "",
    handle: handle ?? ((_q, r) => r.writeHead(404).end()),
    close: async () => {},
  };
  const s: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => f.handle(req, res, body));
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const a = s.address();
  f.origin = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  f.close = () => new Promise((r) => s.close(() => r()));
  return f;
}

export const json = (
  res: ServerResponse,
  status: number,
  v: unknown,
  headers: Record<string, string | string[]> = {},
) =>
  res
    .writeHead(status, { "content-type": "application/json", ...headers })
    .end(JSON.stringify(v));

/** A temp dir of 0600 secret files; `cleanup` removes it. */
export function secretDir(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "oa-redline-test-"));
  for (const [n, v] of Object.entries(files))
    writeFileSync(join(dir, n), v, { mode: 0o600 });
  return {
    dir,
    path: (n: string) => join(dir, n),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
