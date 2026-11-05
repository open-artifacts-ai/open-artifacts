import { env } from "cloudflare:workers";
import worker from "../src/index.js";

export const RENDER_JS = "assets/render-abc123.js";
export const RENDER_CSS = "assets/render-def456.css";
export const CHUNK_JS = "chunk.111.js";
export const LAZY_JS = "lazy.333.js";
export const WORKER_MJS = "pdf.worker.222.mjs";
/** Present in ASSETS and the manifest, but unreachable from the entry. */
export const ORPHAN_JS = "orphan.444.js";
export const RUNTIME_JS = "runtime-xyz789.js";
export const RUNTIME_TAG = `<script src="/_oa/${RUNTIME_JS}"></script>`;

type Files = Record<string, { body: string; type: string }>;

export const DEFAULT_FILES: Files = {
  "/index.html": { body: "<html>SPA</html>", type: "text/html" },
  "/_oa/manifest.json": {
    body: JSON.stringify({
      "src/index.ts": {
        file: RENDER_JS,
        css: [RENDER_CSS],
        isEntry: true,
        imports: ["_chunk.js"],
        dynamicImports: ["lazy.ts"],
      },
      "_chunk.js": { file: CHUNK_JS, assets: [WORKER_MJS] },
      "lazy.ts": {
        file: LAZY_JS,
        isDynamicEntry: true,
        imports: ["_chunk.js"],
      },
      "orphan.ts": { file: ORPHAN_JS },
    }),
    type: "application/json",
  },
  "/_oa/runtime.manifest.json": {
    body: JSON.stringify({
      "src/index.ts": { file: RUNTIME_JS, isEntry: true },
    }),
    type: "application/json",
  },
  [`/_oa/${RENDER_JS}`]: { body: "/*render*/", type: "text/javascript" },
  [`/_oa/${RENDER_CSS}`]: { body: "/*css*/", type: "text/css" },
  [`/_oa/${RUNTIME_JS}`]: { body: "/*runtime*/", type: "text/javascript" },
  [`/_oa/${CHUNK_JS}`]: { body: "/*chunk*/", type: "application/javascript" },
  [`/_oa/${LAZY_JS}`]: { body: "/*lazy*/", type: "text/javascript" },
  [`/_oa/${WORKER_MJS}`]: {
    body: "/*worker*/",
    type: "application/octet-stream",
  },
  [`/_oa/${ORPHAN_JS}`]: { body: "/*orphan*/", type: "text/javascript" },
};

/** A fake ASSETS Fetcher with SPA not-found handling (like production). */
export function fakeAssets(files: Files = DEFAULT_FILES) {
  const calls: string[] = [];
  const fetcher = {
    fetch(input: Request | string) {
      const u = new URL(typeof input === "string" ? input : input.url);
      calls.push(u.pathname);
      const f = files[u.pathname] ?? files["/index.html"];
      if (!f) return Promise.resolve(new Response("nf", { status: 404 }));
      return Promise.resolve(
        new Response(f.body, {
          headers: { "content-type": f.type, etag: '"e1"' },
        }),
      );
    },
  };
  return { fetcher, calls };
}

export const ctx = { waitUntil() {}, passThroughOnException() {} } as never;

/** Calls the Worker on the content host with the given (or default) ASSETS and env overrides. */
export function contentCall(
  path: string,
  init?: RequestInit,
  assets: { fetch: unknown } = fakeAssets().fetcher,
  over: object = {},
) {
  return worker.fetch(
    new Request(`http://content.localhost${path}`, init) as Request<
      unknown,
      IncomingRequestCfProperties
    >,
    { ...(env as object), ASSETS: assets, ...over } as never,
    ctx,
  );
}
