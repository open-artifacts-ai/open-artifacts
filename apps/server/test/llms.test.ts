import { env } from "cloudflare:workers";
import { agentClients, hostSlug, newId, secretFile } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { CONTENT_POLICY, ROUTE_POLICY } from "../src/auth/route-policy.js";
import { signContentPrefix } from "../src/content/signing.js";
import {
  CLAUDE_PLUGIN,
  CLAUDE_PLUGIN_ENABLED,
  LLMS_PATH,
  renderLlms,
} from "../src/mcp/llms.js";
import { skillOrigin } from "../src/mcp/skill-common.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { VERSION } from "../src/version.gen.js";
import { contentCall, DEFAULT_FILES, fakeAssets } from "./assets-stub.js";
import { login } from "./helpers.js";
import { APP, callWorker, E } from "./mcp-helpers.js";

const CONTENT = "https://content.localhost";
const HOST = new URL(APP).host;

const get = (url: string, init: RequestInit = {}, e: unknown = E()) =>
  callWorker(new Request(url, init), e);
const guide = async (e: unknown = E()) => {
  const r = await get(`${APP}${LLMS_PATH}`, {}, e);
  expect(r.status).toBe(200);
  return r.text();
};

/** `## name` → that section's text. */
const sections = (txt: string) =>
  new Map(
    txt
      .split(/\n## /)
      .slice(1)
      .map((s) => {
        const [h, ...rest] = s.split("\n");
        return [h ?? "", rest.join("\n")] as const;
      }),
  );

/** Every fenced code block's body, in order. */
const codeBlocks = (txt: string) =>
  [...txt.matchAll(/```[a-z]*\n([\s\S]*?)\n```/g)].map((m) => m[1]);

describe("GET /llms.txt", () => {
  it("app host: 200 plain text, cacheable, ETag/304, HEAD", async () => {
    const r = await get(`${APP}/llms.txt`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(r.headers.get("cache-control")).toBe("public, max-age=300");
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("set-cookie")).toBeNull();
    const etag = r.headers.get("etag") ?? "";
    expect(etag.startsWith(`"${VERSION}-llms-`)).toBe(true);
    expect(etag).toMatch(/-llms-[0-9a-f]{8}"$/);
    for (const inm of [etag, `W/${etag}`, "*"]) {
      const nm = await get(`${APP}/llms.txt`, {
        headers: { "if-none-match": inm },
      });
      expect(nm.status).toBe(304);
      expect(await nm.text()).toBe("");
    }
    const head = await get(`${APP}/llms.txt`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("etag")).toBe(etag);
  });

  it("content host: 404; every other method: 405", async () => {
    expect((await get(`${CONTENT}/llms.txt`)).status).toBe(404);
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const r = await get(`${APP}/llms.txt`, { method });
      expect(r.status, method).toBe(405);
      expect(r.headers.get("allow")).toBe("GET, HEAD");
    }
  });

  it("is public in the route policy, GET and ALL", () => {
    expect(ROUTE_POLICY["GET /llms.txt"]).toHaveProperty("public");
    expect(ROUTE_POLICY["ALL /llms.txt"]).toEqual({ public: "405" });
    expect(Object.keys(CONTENT_POLICY)).not.toContain("GET /llms.txt");
  });

  it("touches no D1 binding", async () => {
    let touched = 0;
    const DB = new Proxy(
      {},
      {
        get() {
          touched++;
          throw new Error("D1 touched");
        },
      },
    );
    expect((await get(`${APP}/llms.txt`, {}, E({ DB }))).status).toBe(200);
    expect(touched).toBe(0);
  });

  it("has Connect, Restart, Verify and Troubleshoot, in order, for this instance", async () => {
    const txt = await guide();
    expect(txt.startsWith(`# Open Artifacts at ${HOST}\n`)).toBe(true);
    expect([...sections(txt).keys()]).toEqual([
      "Connect",
      "Restart",
      "Verify",
      "Troubleshoot",
    ]);
    expect(txt).toContain(`${skillOrigin(HOST)}/mcp`);
    expect(sections(txt).get("Verify")).toContain(
      `${skillOrigin(HOST)}/skill.md`,
    );
  });

  it("works the same on hosted and self-hosted", async () => {
    const self = await guide(E({ HOSTED: undefined }));
    expect(await guide(E({ HOSTED: "1" }))).toBe(self);
  });

  it("SKILL_MD=off: still served, without the /skill.md step", async () => {
    const txt = await guide(E({ SKILL_MD: "off" }));
    expect(txt).not.toContain("/skill.md");
    expect(sections(txt).get("Verify")).toContain("1. List the server's tools");
  });
});

describe("llms.txt can't drift from agentClients", () => {
  const origin = skillOrigin(HOST);
  const mcpUrl = `${origin}/mcp`;
  const tokenFile = secretFile("pat", { hostSlug: hostSlug(HOST) });
  // What this guarantees: the guide calls agentClients with the same
  // arguments as the dashboard (apps/dashboard/src/settings/Agents.tsx), an
  // mcpUrl and { tokenFile }, with mcpUrl built from skillOrigin(APP_HOST).
  // The dashboard derives its origin separately (appOrigin / location), the
  // same split /skill.md has, so the two agree whenever those origins do.
  const all = agentClients(mcpUrl, { tokenFile });
  const oauth = all.filter((s) => s.variant === "oauth");
  const token = all.filter((s) => s.variant === "token");

  it("Connect's code blocks are agentClients' OAuth then token snippets, in order", async () => {
    const connect = sections(await guide()).get("Connect") ?? "";
    expect(codeBlocks(connect)).toEqual([
      ...oauth.map((s) => s.code),
      ...oauth.flatMap((o) =>
        token
          .filter((t) => t.agent === o.agent && t.language !== "text")
          .map((t) => t.code),
      ),
    ]);
    expect([...connect.matchAll(/^### (.+)$/gm)].map((m) => m[1])).toEqual(
      oauth.map((s) => s.agent),
    );
    expect([...connect.matchAll(/^#### (.+)$/gm)].map((m) => m[1])).toEqual(
      oauth.map((s) => s.agent),
    );
    for (const s of all) {
      expect(connect).toContain(`Then: ${s.verify}`);
      if (s.file) expect(connect).toContain(`\`${s.file}\``);
      if (s.hint) expect(connect).toContain(`Note: ${s.hint}`);
      if (s.language === "text") expect(connect).toContain(s.code);
    }
    // Cursor has no token variant: it gets a note instead.
    expect(token.map((t) => t.agent)).not.toContain("Cursor");
    expect(connect).toContain(
      "#### Cursor\nNo token-file option: sign in through the browser as above.",
    );
  });

  it("no rendered snippet contains a literal token", async () => {
    const txt = await guide();
    expect(token.length).toBeGreaterThan(0);
    for (const s of all) {
      expect(s.code, s.agent).not.toMatch(/oa_pat_|Bearer oa_/);
      expect(s.code, s.agent).not.toContain("<YOUR_TOKEN>");
    }
    for (const t of token) expect(t.code).toContain(tokenFile);
    // A real token, as createPat makes them, never appears.
    expect(txt).not.toMatch(/oa_pat_[1-9A-HJ-NP-Za-km-z]{32}/);
  });

  it("Restart is agentClients' reload line per client", async () => {
    const restart = sections(await guide()).get("Restart") ?? "";
    expect(restart.trim().split("\n")).toEqual(
      oauth.map((s) => `- ${s.agent}: ${s.reload}`),
    );
  });

  it("names the token file, never a token, Bearer value, email or secret", async () => {
    const txt = await guide();
    expect(txt).toContain(`\`${tokenFile}\``);
    // Token snippets name the header ("Bearer %s", "Bearer {file:...}"),
    // never a value.
    expect(txt).not.toMatch(/Bearer oa_/);
    expect(txt).not.toMatch(/oa_pat_/);
    expect(txt).toContain("Personal access tokens");
    expect(txt).toContain("they ask their admin");
    expect(txt).toContain("never ask the person for it");
    expect(txt).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    const secrets = Object.entries(env as unknown as Record<string, unknown>)
      .filter(([k, v]) => /SECRET|KEY|TOKEN|PASSWORD/.test(k) && v)
      .map(([, v]) => String(v))
      .filter((v) => v.length >= 8);
    expect(secrets.length).toBeGreaterThan(0);
    for (const s of secrets) expect(txt).not.toContain(s);
  });
});

describe("Claude Code plugin switch", () => {
  it("is off by default, and the served guide omits the block", async () => {
    expect(CLAUDE_PLUGIN_ENABLED).toBe(false);
    const txt = await guide();
    expect(txt).toBe(renderLlms(HOST, { plugin: false }));
    expect(txt).not.toContain("claude plugin");
    expect(txt).not.toContain("prefer the plugin");
    expect(txt).not.toContain(CLAUDE_PLUGIN.option);
  });

  it("on: the block installs the plugin and points it at this instance", () => {
    const on = renderLlms(HOST, { plugin: true });
    const origin = skillOrigin(HOST);
    expect(on).toContain("### Claude Code: prefer the plugin");
    expect(on).toContain(
      `claude plugin marketplace add ${CLAUDE_PLUGIN.marketplace}`,
    );
    expect(on).toContain(`claude plugin install ${CLAUDE_PLUGIN.name}`);
    expect(on).toContain(
      `printf '{"instance_url":"${origin}"}' | claude plugin configure ${CLAUDE_PLUGIN.name} --values-stdin`,
    );
    // Same guide otherwise: the block is the only difference.
    const off = renderLlms(HOST, { plugin: false });
    const block = on.slice(
      on.indexOf("### Claude Code: prefer the plugin"),
      on.indexOf("If a client can only use a token"),
    );
    expect(on.replace(block, "")).toBe(off);
  });
});

describe("served .txt and .md paths on the app host", () => {
  // Every GET route on the app host ending in .txt or .md (the route table).
  const served = Object.keys(ROUTE_POLICY)
    .filter((k) => /^GET \/[^*:]*\.(txt|md)$/.test(k))
    .map((k) => k.slice("GET ".length));

  it("the list is the one we expect", () => {
    expect(served.sort()).toEqual(
      ["/llms.txt", "/robots.txt", "/skill.md", "/upgrade.md"].sort(),
    );
  });

  it("each still serves 200 (self-hosted, with the SPA fallback live)", async () => {
    const assets = fakeAssets();
    for (const p of served) {
      const r = await get(`${APP}${p}`, {}, E({ ASSETS: assets.fetcher }));
      expect(r.status, p).toBe(200);
    }
    expect(assets.calls).toEqual([]);
  });

  it("content host: robots.txt still serves 200", async () => {
    const txt = Object.keys(CONTENT_POLICY)
      .filter((k) => /^GET \/[^*:]*\.(txt|md)$/.test(k))
      .map((k) => k.slice("GET ".length));
    expect(txt).toEqual(["/robots.txt"]);
    for (const p of txt) expect((await contentCall(p)).status, p).toBe(200);
  });

  it("unknown .txt and .md paths: plain 404, never the SPA shell", async () => {
    const assets = fakeAssets();
    const e = E({ ASSETS: assets.fetcher });
    for (const p of [
      "/nope.txt",
      "/nope.md",
      "/README.MD",
      "/docs/guide.md",
      "/settings/llms.txt",
      "/a/abc/notes.md",
      "/llms.txt/x.txt",
      // Missing bundle files: ASSETS answers its SPA shell; we don't.
      "/assets/missing.txt",
      "/assets/missing.md",
    ]) {
      for (const method of ["GET", "HEAD"]) {
        const r = await get(`${APP}${p}`, { method }, e);
        expect(r.status, `${method} ${p}`).toBe(404);
        expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
        if (method === "GET") expect(await r.text()).toBe("Not found\n");
      }
    }
    // Only the /assets/ paths reach ASSETS.
    expect(new Set(assets.calls)).toEqual(
      new Set(["/assets/missing.txt", "/assets/missing.md"]),
    );
  });

  it("a missing bundle .txt that ASSETS 404s is the same plain 404", async () => {
    const nf = {
      fetch: () => Promise.resolve(new Response("nf", { status: 404 })),
    };
    const r = await get(`${APP}/assets/gone.md`, {}, E({ ASSETS: nf }));
    expect(r.status).toBe(404);
    expect(await r.text()).toBe("Not found\n");
  });

  it("a bundle .txt revalidation (304 from ASSETS) stays a 304", async () => {
    const nm = {
      fetch: () => Promise.resolve(new Response(null, { status: 304 })),
    };
    const r = await get(`${APP}/assets/licenses.txt`, {}, E({ ASSETS: nm }));
    expect(r.status).toBe(304);
  });

  it("everything else still falls through to the SPA as before", async () => {
    const assets = fakeAssets();
    const e = E({ ASSETS: assets.fetcher });
    for (const p of ["/", "/settings/agents", "/search", "/a/x/y", "/x.html"]) {
      const r = await get(`${APP}${p}`, {}, e);
      expect(r.status, p).toBe(200);
      expect(await r.text(), p).toContain("SPA");
    }
    // Built bundle files under /assets/ keep going to ASSETS, .txt or .md.
    const bundle = fakeAssets({
      ...DEFAULT_FILES,
      "/assets/licenses.txt": { body: "MIT", type: "text/plain" },
      "/assets/notes.md": { body: "# n", type: "text/markdown" },
    });
    const be = E({ ASSETS: bundle.fetcher });
    for (const [p, body] of [
      ["/assets/licenses.txt", "MIT"],
      ["/assets/notes.md", "# n"],
    ] as const) {
      const r = await get(`${APP}${p}`, {}, be);
      expect(r.status, p).toBe(200);
      expect(await r.text(), p).toBe(body);
    }
    expect(bundle.calls).toEqual(["/assets/licenses.txt", "/assets/notes.md"]);
    // Worker prefixes keep their JSON 404, .txt or not.
    for (const p of ["/api/v1/x.txt", "/.well-known/security.txt"]) {
      const r = await get(`${APP}${p}`, {}, e);
      expect(r.status, p).toBe(404);
      expect(r.headers.get("content-type"), p).toMatch(/^application\/json/);
    }
  });
});

describe("content host: an artifact's .md and .txt files", () => {
  let id = "";
  beforeAll(async () => {
    const l = await login(`llms-${newId().slice(0, 6).toLowerCase()}@x.com`);
    const m = await getUser(env, l.userId);
    if (!m) throw new Error("no user");
    id = (
      await publish(
        env,
        m,
        {
          title: "files",
          format: "html",
          entry: "index.html",
          files: {
            "index.html": "<p>hi</p>",
            "notes.md": "# notes",
            "docs/readme.txt": "plain",
            "llms.txt": "artifact llms",
          },
        } as never,
        null,
        undefined,
        "create",
      )
    ).id;
  });

  it("still serves them from the content host", async () => {
    const prefix = await signContentPrefix(env, id, 1);
    for (const [p, body] of [
      ["notes.md", "# notes"],
      ["docs/readme.txt", "plain"],
      ["llms.txt", "artifact llms"],
    ] as const) {
      const r = await contentCall(`${prefix}${p}`);
      expect(r.status, p).toBe(200);
      expect(await r.text(), p).toBe(body);
    }
  });
});
