import { env } from "cloudflare:workers";
import { type Member, newId, R, viewerPath } from "@oa/shared";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import { publicPrefix, signContentPrefix } from "../src/content/signing.js";
import {
  embedOrigins,
  frameOpts,
  normHost,
  siteOf,
} from "../src/http/embed.js";
import { withSecurityHeaders } from "../src/http/middleware.js";
import worker from "../src/index.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { ctx, fakeAssets } from "./assets-stub.js";
import { api, errOf, login } from "./helpers.js";

const G = "https://open-artifacts.com";
const CONTENT_CSP =
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";
const assets = fakeAssets({
  "/index.html": {
    body: "<!doctype html><html><head><title>x</title></head><body></body></html>",
    type: "text/html",
  },
}).fetcher;

const call = (url: string, extra: object = {}, init?: RequestInit) =>
  worker.fetch(
    new Request(url, init) as Request<unknown, IncomingRequestCfProperties>,
    { ...(env as object), ASSETS: assets, ...extra } as never,
    ctx,
  );
const app = (path: string, extra: object = {}, init?: RequestInit) =>
  call(`http://app.localhost${path}`, extra, init);
const cAssets = fakeAssets().fetcher;
/** Content host; by default the public /p/ view of `id`. */
const content = (extra: object = {}, path?: string) =>
  call(`http://content.localhost${path ?? `${publicPrefix(id, 1)}__view`}`, {
    ASSETS: cAssets,
    ...extra,
  });

const prod = (v: string) =>
  embedOrigins({ EMBED_ORIGINS: v, ENVIRONMENT: "production" });
const dev = (v: string) =>
  embedOrigins({ EMBED_ORIGINS: v, ENVIRONMENT: "dev" });

let id: string;
let cookie: string;
let owner: Member;
beforeAll(async () => {
  const l = await login(`em-${newId().slice(0, 6).toLowerCase()}@x.com`);
  cookie = l.cookie;
  owner = (await getUser(env, l.userId)) as Member;
  id = (
    await publish(
      env,
      owner,
      {
        title: "EmbedMe",
        visibility: "public",
        format: "markdown",
        content: "x",
      } as never,
      null,
      undefined,
      "create",
    )
  ).id;
});
afterEach(() => vi.restoreAllMocks());

describe("EMBED_ORIGINS parsing", () => {
  it("keeps bare https origins, normalized and de-duplicated", () => {
    expect(prod("")).toEqual([]);
    expect(prod(`  ${G}\thttps://B.example.com:8443 ${G} `)).toEqual([
      G,
      "https://b.example.com:8443",
    ]);
  });

  it("drops invalid entries and logs once per value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = [
      "http://evil.com",
      `${G}/`,
      `${G}/path`,
      `${G}?q`,
      `${G}#f`,
      "https://u:p@x.com",
      "https://*.example.com",
      "*",
      "'none'",
      "'self'",
      "none",
      "https:",
      "data:",
      "javascript:alert(1)",
      "https://x.com:443",
      "https://x.com:99999",
      "https://exämple.com",
    ];
    const v = [...bad, G].join(" ");
    expect(prod(v)).toEqual([G]);
    expect(prod(v)).toEqual([G]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      `dropped ${bad.length} invalid`,
    );
  });

  it("allows http://localhost only in dev", () => {
    const v = "http://localhost:5173 http://gallery.localhost";
    expect(dev(v)).toEqual([
      "http://localhost:5173",
      "http://gallery.localhost",
    ]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(prod(v)).toEqual([]);
    expect(dev("http://localhost.evil.com")).toEqual([]);
  });

  it("rejects header-injection attempts", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const v of [
      `${G}\r\nX-Evil: 1`,
      `${G}\nX-Evil: 1`,
      `${G};script-src *`,
      `${G},https://b.com`,
      `${G}'`,
      `${G}\u0000`,
    ])
      expect(prod(v)).toEqual([]);
    // Space-separated junk around a good origin never reaches the list.
    expect(prod(`${G} ; script-src * 'unsafe-inline'`)).toEqual([G]);
  });

  it("frameOpts relaxes only GET/HEAD /a/:id/full", () => {
    const e = { EMBED_ORIGINS: G, ENVIRONMENT: "production" as const };
    const ok = { frameAncestors: `'self' ${G}` };
    expect(frameOpts(e, "GET", "/a/x/full")).toEqual(ok);
    expect(frameOpts(e, "HEAD", "/a/x/full")).toEqual(ok);
    for (const [m, p] of [
      ["POST", "/a/x/full"],
      ["GET", "/a/x"],
      ["GET", "/a/x/full/"],
      ["GET", "/a/x/y/full"],
      ["GET", "/a/x/v/1"],
      ["GET", "/api/v1/artifacts/x/full"],
      ["GET", "/"],
    ] as const)
      expect(frameOpts(e, m, p)).toEqual({ frameDeny: true });
    expect(frameOpts({ ...e, EMBED_ORIGINS: "" }, "GET", "/a/x/full")).toEqual({
      frameDeny: true,
    });
  });
});

describe("EMBED_ORIGINS headers", () => {
  it("default: DENY on every app route, content framed by the app only", async () => {
    for (const p of [
      `${viewerPath(id)}/full`,
      viewerPath(id),
      "/",
      "/healthz",
    ]) {
      const r = await app(p);
      expect(r.headers.get("x-frame-options"), p).toBe("DENY");
      expect(r.headers.get("content-security-policy"), p).toBeNull();
    }
    expect((await content()).headers.get("content-security-policy")).toBe(
      `${CONTENT_CSP}; frame-ancestors http://app.localhost`,
    );
  });

  it("set: /full allows 'self' + origins; other routes stay DENY", async () => {
    const extra = { EMBED_ORIGINS: `${G} https://b.example.com` };
    const full = await app(`${viewerPath(id)}/full`, extra);
    expect(full.status).toBe(200);
    expect(full.headers.get("x-frame-options")).toBeNull();
    expect(full.headers.get("content-security-policy")).toBe(
      `frame-ancestors 'self' ${G} https://b.example.com`,
    );
    // Anonymous (no cookie, as in a third-party frame): public OG still served.
    expect(await full.text()).toContain("EmbedMe");
    const head = await app(`${viewerPath(id)}/full`, extra, { method: "HEAD" });
    expect(head.headers.get("x-frame-options")).toBeNull();
    for (const p of [
      viewerPath(id),
      `${viewerPath(id)}/v/1`,
      "/",
      "/healthz",
      `/api/v1/artifacts/${id}`,
      `${viewerPath(id)}/full/`,
    ]) {
      const r = await app(p, extra);
      expect(r.headers.get("x-frame-options"), p).toBe("DENY");
      expect(r.headers.get("content-security-policy") ?? "", p).not.toContain(
        G,
      );
    }
    const post = await app(`${viewerPath(id)}/full`, extra, { method: "POST" });
    expect(post.headers.get("x-frame-options")).toBe("DENY");
    const pub = await content(extra);
    expect(pub.status).toBe(200);
    expect(pub.headers.get("content-security-policy")).toBe(
      `${CONTENT_CSP}; frame-ancestors http://app.localhost ${G} https://b.example.com`,
    );
    // Signed (private-capable) content and errors stay app-only.
    const appOnly = `${CONTENT_CSP}; frame-ancestors http://app.localhost`;
    const signed = await content(
      extra,
      `${await signContentPrefix(env, id, 1)}__view`,
    );
    expect(signed.status).toBe(200);
    expect(signed.headers.get("content-security-policy")).toBe(appOnly);
    for (const p of [`/p/${newId()}/v1/__view`, "/robots.txt", "/nope"]) {
      const r = await content(extra, p);
      expect(r.headers.get("content-security-policy"), p).toBe(appOnly);
    }
  });

  it("merges frameAncestors into an existing csp option (one header)", () => {
    const r = withSecurityHeaders(new Response("x"), {
      csp: "default-src 'none'",
      frameAncestors: `'self' ${G}`,
    });
    expect(r.headers.get("content-security-policy")).toBe(
      `default-src 'none'; frame-ancestors 'self' ${G}`,
    );
    expect(r.headers.get("x-frame-options")).toBeNull();
  });

  it("rejects same-site origins unless EMBED_ALLOW_SAME_SITE=1", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const e = {
      ENVIRONMENT: "production" as const,
      APP_HOST: "artifacts.open-artifacts.com",
      EMBED_ORIGINS: `${G} https://x.open-artifacts.com https://gallery.example.org`,
    };
    expect(embedOrigins(e)).toEqual(["https://gallery.example.org"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("same-site");
    expect(String(warn.mock.calls[0]?.[1])).toContain(G);
    for (const v of ["", "0", "true", "yes"])
      expect(embedOrigins({ ...e, EMBED_ALLOW_SAME_SITE: v })).toEqual([
        "https://gallery.example.org",
      ]);
    expect(embedOrigins({ ...e, EMBED_ALLOW_SAME_SITE: "1" })).toEqual([
      G,
      "https://x.open-artifacts.com",
      "https://gallery.example.org",
    ]);
    // End to end: a same-site-only list leaves /full at DENY. The request goes
    // to the configured APP_HOST: any other host is 404 before routing.
    const full = await call(`http://app.example.com${viewerPath(id)}/full`, {
      APP_HOST: "app.example.com",
      EMBED_ORIGINS: "https://gallery.example.com",
    });
    expect(full.headers.get("x-frame-options")).toBe("DENY");
  });

  it("same-site check normalizes case, port, brackets and trailing dots", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const prodE = { ENVIRONMENT: "production" as const };
    expect(
      embedOrigins({
        ...prodE,
        APP_HOST: "Demo.Open-Artifacts.com.:443",
        EMBED_ORIGINS: `${G} https://Gallery.Open-Artifacts.COM. https://ok.example.org`,
      }),
    ).toEqual(["https://ok.example.org"]);
    expect(
      embedOrigins({
        ...prodE,
        APP_HOST: "Demo.Open-Artifacts.com.:443",
        EMBED_ORIGINS: G,
        EMBED_ALLOW_SAME_SITE: "1",
      }),
    ).toEqual([G]);
    // localhost (dev): ports differ, same site -> rejected.
    expect(
      embedOrigins({
        ENVIRONMENT: "dev",
        APP_HOST: "localhost:8787",
        EMBED_ORIGINS: "http://localhost:5173 http://gallery.localhost",
      }),
    ).toEqual(["http://gallery.localhost"]);
    // IP literals are their own site.
    expect(normHost("[::1]:8787")).toBe("::1");
    expect(siteOf(normHost("[::1]:8787"))).toBe("::1");
    expect(siteOf("10.0.0.1")).toBe("10.0.0.1");
    expect(
      embedOrigins({
        ...prodE,
        APP_HOST: "[2001:db8::1]:443",
        EMBED_ORIGINS: "https://db8.example.com",
      }),
    ).toEqual(["https://db8.example.com"]);
    expect(
      embedOrigins({
        ...prodE,
        APP_HOST: "203.0.113.5:8443",
        EMBED_ORIGINS: "https://203.0.113.5 https://0.113.5.example.com",
      }),
    ).toEqual(["https://0.113.5.example.com"]);
  });

  it("injection attempts never reach a header", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const extra = {
      EMBED_ORIGINS: `${G};script-src * https://x.com https://y.com\r\nX-Evil:1`,
    };
    const full = await app(`${viewerPath(id)}/full`, extra);
    expect(full.headers.get("x-evil")).toBeNull();
    expect(full.headers.get("x-frame-options")).toBeNull();
    expect(full.headers.get("content-security-policy")).toBe(
      "frame-ancestors 'self' https://x.com",
    );
    const all = await app(`${viewerPath(id)}/full`, {
      EMBED_ORIGINS: `${G};script-src *`,
    });
    expect(all.headers.get("x-frame-options")).toBe("DENY");
    expect(all.headers.get("content-security-policy")).toBeNull();
    expect(
      (
        await content({ EMBED_ORIGINS: "'self' * http://evil.com" })
      ).headers.get("content-security-policy"),
    ).toBe(`${CONTENT_CSP}; frame-ancestors http://app.localhost`);
  });
});

const pubArt = async (extra: Record<string, unknown>) =>
  (
    await publish(
      env,
      owner,
      {
        title: "Live",
        format: "html",
        content: "<p>x</p>",
        capabilities: { db: true },
        ...extra,
      } as never,
      null,
      undefined,
      "create",
    )
  ).id;
const EMBED = { "x-oa-embed": "1" };
const META = `<meta name="oa-embed" content="1">`;
const inner = createApp();

describe("embed-mode hints (enforcement is client-side; these are hints)", () => {
  it("framed /full carries the oa-embed meta; top-level /full and /a/:id don't", async () => {
    const full = `${viewerPath(id)}/full`;
    const framed = await (
      await app(full, {}, { headers: { "sec-fetch-dest": "iframe" } })
    ).text();
    expect(framed).toContain(META);
    for (const dest of ["document", null]) {
      const h: Record<string, string> = { cookie };
      if (dest) h["sec-fetch-dest"] = dest;
      const r = await app(full, {}, { headers: h });
      expect(r.headers.get("vary")).toBe("Sec-Fetch-Dest");
      expect(await r.text()).not.toContain(META);
    }
    expect(
      await (
        await app(
          viewerPath(id),
          {},
          { headers: { "sec-fetch-dest": "iframe" } },
        )
      ).text(),
    ).not.toContain(META);
    // Top-level: the cookie still signs the SPA in.
    expect((await api(inner, R.me, cookie)).status).toBe(200);
  });

  it("X-OA-Embed: cookie and PAT are ignored", async () => {
    const pat = (await createPat(env, owner.id, "em")).token;
    const priv = await pubArt({ visibility: "private" });
    for (const auth of [cookie, pat]) {
      expect((await api(inner, R.me, auth)).status).toBe(200);
      expect((await api(inner, R.me, auth, { headers: EMBED })).status).toBe(
        401,
      );
      expect((await api(inner, R.artifact(priv), auth)).status).toBe(200);
      expect(
        (await api(inner, R.artifact(priv), auth, { headers: EMBED })).status,
      ).toBe(404);
      expect(
        (await api(inner, R.artifact(id), auth, { headers: EMBED })).status,
      ).toBe(200);
      expect(
        (await api(inner, `${R.me}?embed=1`, auth)).status,
        "?embed=1",
      ).toBe(401);
    }
    // Only exactly "1" switches embed mode on.
    expect(
      (await api(inner, R.me, cookie, { headers: { "x-oa-embed": "0" } }))
        .status,
    ).toBe(200);
  });

  it("anonymous write rules apply under X-OA-Embed", async () => {
    const ip = { "cf-connecting-ip": `198.51.100.${(Date.now() % 250) + 1}` };
    const closed = await pubArt({ visibility: "public" });
    const put = (art: string, headers: Record<string, string>) =>
      api(inner, R.dataDoc(art, "c", "a"), cookie, {
        method: "PUT",
        body: 1,
        headers: { ...ip, ...headers },
      });
    expect((await put(closed, {})).status).toBe(200);
    const refused = await put(closed, EMBED);
    expect(refused.status).toBe(403);
    expect((await errOf(refused)).code).toBe("anon_writes_disabled");
    const open = await pubArt({
      visibility: "public",
      allowAnonymousWrites: true,
    });
    const w = await put(open, EMBED);
    expect(w.status).toBe(200);
    expect(((await w.json()) as { updatedBy: string }).updatedBy).toMatch(
      /^anon(:|$)/,
    );
  });

  it("WebSocket with ?embed=1 is anonymous", async () => {
    const team = await pubArt({ visibility: "team" });
    const up = { upgrade: "websocket" };
    const signed = await api(inner, R.dataSubscribe(team, "c"), cookie, {
      headers: up,
    });
    expect(signed.status).toBe(101);
    signed.webSocket?.accept();
    signed.webSocket?.close();
    const embedded = await api(
      inner,
      `${R.dataSubscribe(team, "c")}&embed=1`,
      cookie,
      { headers: up },
    );
    expect(embedded.status).toBe(404);
  });
});
