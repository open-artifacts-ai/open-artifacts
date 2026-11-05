import { isId, viewerPath } from "@oa/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { getDb } from "../db/client.js";
import { artifacts } from "../db/schema.js";
import type { Env } from "../env.js";
import { isFramedFetch } from "../http/embed.js";
import { appOrigin, contentOrigin } from "../http/errors.js";
import type { AppEnv } from "../http/middleware.js";
import { getSettings } from "../services/members.js";
import type { AppType } from "./index.js";

const SITE = "Open Artifacts";
/** Embed-mode marker for the dashboard (see http/embed.ts). */
export const EMBED_META = `<meta name="oa-embed" content="1">`;
const VERSION_NUM = /^[1-9]\d{0,8}$/;

// Bidi controls, zero-width characters, word joiner/invisibles and BOM.
const INVISIBLE =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;
const clean = (s: string) => s.replace(INVISIBLE, "");

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

type Og = {
  title: string;
  description: string | null;
  url: string;
  image: string | null;
};

/** Public, live artifacts only; anything else (incl. a malformed id) is null. */
async function publicOg(
  env: Env,
  id: string,
  v: number | undefined,
): Promise<Og | null> {
  if (!isId(id)) return null;
  const a = (
    await getDb(env)
      .select({
        title: artifacts.title,
        description: artifacts.description,
        hasThumbnail: artifacts.hasThumbnail,
      })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.id, id),
          eq(artifacts.visibility, "public"),
          isNull(artifacts.deletedAt),
        ),
      )
      .limit(1)
  )[0];
  if (!a) return null;
  const origin = appOrigin(env);
  return {
    title: clean(a.title),
    description: a.description
      ? Array.from(clean(a.description)).slice(0, 300).join("")
      : null,
    url: origin + viewerPath(id, v),
    image: a.hasThumbnail ? `${origin}/api/v1/artifacts/${id}/thumbnail` : null,
  };
}

function metaTags(og: Og): string {
  const m = (p: string, v: string) =>
    `<meta property="${p}" content="${esc(v)}">`;
  return [
    m("og:title", og.title),
    og.description ? m("og:description", og.description) : "",
    m("og:type", "website"),
    m("og:url", og.url),
    og.image ? m("og:image", og.image) : "",
  ].join("");
}

const NAME_TTL_MS = 60_000;
/** Per isolate (per D1 binding); the name is display-only, never authz. */
const nameMemo = new WeakMap<D1Database, { name: string; at: number }>();

/**
 * Shell contract for the dashboard: every SPA shell HTML response carries
 * `<meta name="oa-instance" content="<settings.name>">` in its <head> (omitted
 * if the settings read fails), so signed-out pages can show the instance name.
 * The name is memoized per isolate for 60 s, so it may be up to 60 s stale.
 */
export async function instanceMeta(
  env: Env,
  now = Date.now(),
): Promise<string> {
  let m = nameMemo.get(env.DB);
  if (!m || now - m.at >= NAME_TTL_MS) {
    try {
      m = { name: (await getSettings(env)).name, at: now };
    } catch {
      return "";
    }
    nameMemo.set(env.DB, m);
  }
  return `<meta name="oa-instance" content="${esc(m.name)}">`;
}

/** SPA fallback: injects the instance meta into an HTML shell response. */
export async function withInstanceMeta(
  env: Env,
  res: Response,
): Promise<Response> {
  if (!res.ok || !res.headers.get("content-type")?.startsWith("text/html"))
    return res;
  const meta = await instanceMeta(env);
  if (!meta) return res;
  const headers = new Headers(res.headers);
  // The body changed: the asset's length and validator no longer apply.
  headers.delete("content-length");
  headers.delete("etag");
  const body = new HTMLRewriter()
    .on("head", {
      element(e) {
        e.append(meta, { html: true });
      },
    })
    .transform(res).body;
  return new Response(body, { status: res.status, headers });
}

const HOME_TTL_MS = 60_000;
/** Per isolate (per D1 binding): PUBLIC_HOME's last check, for HOME_TTL_MS. */
const homeMemo = new WeakMap<
  D1Database,
  { id: string; ok: boolean; at: number }
>();
const badHomeLogged = new Set<string>();

/**
 * PUBLIC_HOME: `/a/<id>/full` when the var names a live public artifact, else
 * null (unset, invalid, private, missing or deleted: the caller serves "/" as
 * if unset, so nothing leaks). At most one D1 read per isolate per 60 s.
 */
export async function publicHome(
  env: Env,
  now = Date.now(),
): Promise<string | null> {
  const id = env.PUBLIC_HOME?.trim();
  if (!id) return null;
  if (!isId(id)) {
    if (!badHomeLogged.has(id)) {
      badHomeLogged.add(id);
      console.warn("PUBLIC_HOME ignored: not an artifact id");
    }
    return null;
  }
  let m = homeMemo.get(env.DB);
  if (!m || m.id !== id || now - m.at >= HOME_TTL_MS) {
    let ok: boolean;
    try {
      ok =
        (await env.DB.prepare(
          "select 1 from artifacts where id = ? and visibility = 'public' and deleted_at is null limit 1",
        )
          .bind(id)
          .first()) !== null;
    } catch {
      return null;
    }
    if (!ok)
      console.warn(`PUBLIC_HOME ${id} ignored: not a live public artifact`);
    m = { id, ok, at: now };
    homeMemo.set(env.DB, m);
  }
  return m.ok ? `/a/${id}/full` : null;
}

export function mountShell(app: AppType): void {
  const shell = async (
    c: Context<AppEnv>,
    id: string,
    v?: number,
    embed = false,
  ) => {
    const [og, meta, index] = await Promise.all([
      publicOg(c.env, id, v),
      instanceMeta(c.env),
      c.env.ASSETS.fetch(new Request(new URL("/", c.req.url))),
    ]);
    if (!index.ok) return index;
    const rewritten = new HTMLRewriter()
      .on("title", {
        element(e) {
          e.setInnerContent(og ? `${og.title} · ${SITE}` : SITE);
        },
      })
      .on("head", {
        element(e) {
          e.append(
            (embed ? EMBED_META : "") +
              // The artifact frame loads from here: open the connection early (#693).
              `<link rel="preconnect" href="${esc(contentOrigin(c.env))}">` +
              meta +
              (og ? metaTags(og) : ""),
            { html: true },
          );
        },
      })
      .transform(index);
    return new Response(rewritten.body, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        Vary: "Sec-Fetch-Dest",
      },
    });
  };
  app.get("/a/:id", (c) => shell(c, c.req.param("id")));
  // Chromeless viewer (#290): same shell, checks and OG; og:url stays canonical.
  // Framed (any non-document Sec-Fetch-Dest): add the oa-embed meta, a hint
  // for the dashboard's embed mode. The shell never reads the session, so this
  // render is not where anonymity is enforced (that is client-side).
  app.get("/a/:id/full", (c) =>
    shell(c, c.req.param("id"), undefined, isFramedFetch(c.req.raw)),
  );
  app.get("/a/:id/v/:v", async (c, next) => {
    const v = c.req.param("v");
    if (!VERSION_NUM.test(v)) return next();
    return shell(c, c.req.param("id"), Number(v));
  });
}
