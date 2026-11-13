// A tiny static server over the built site, for the real-browser checks.
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve } from "node:path";

const dist = resolve(import.meta.dirname, "../dist");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

export async function serveDist(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    let path = join(dist, new URL(req.url ?? "/", "http://x").pathname);
    if (existsSync(path) && statSync(path).isDirectory())
      path = join(path, "index.html");
    if (!existsSync(path)) return res.writeHead(404).end();
    res.writeHead(200, {
      "content-type": TYPES[extname(path)] ?? "application/octet-stream",
    });
    res.end(readFileSync(path));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    server,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}
