import { env } from "cloudflare:workers";
import {
  agentClients,
  dataDocLimit,
  dataLimits,
  LIMITS,
  newId,
  type Plan,
} from "@oa/shared";
import { describe, expect, it, vi } from "vitest";
import { createPat } from "../src/auth/pat.js";
import { INSTRUCTIONS, planText, sizeText } from "../src/mcp/instructions.js";
import { SKILL_HASH, SKILL_TEMPLATE } from "../src/mcp/skill.generated.js";
import { renderSkill, SKILL_DOC_URI, upgradeLine } from "../src/mcp/skill.js";
import {
  hostSlug,
  SECRET_LABELS,
  SKILL_NAME_MAX,
  secretFile,
  secretRules,
  secretSnippet,
  skillName,
  skillOrigin,
} from "../src/mcp/skill-common.js";
import { renderSkillTemplate } from "../src/mcp/skill-template.js";
import { TOOL_DEFS } from "../src/mcp/tool-defs.js";
import { VERSION } from "../src/version.gen.js";
import { login } from "./helpers.js";
import { APP, callWorker, connect, E } from "./mcp-helpers.js";

const CONTENT = "https://content.localhost";
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const get = (url: string, init: RequestInit = {}, e: unknown = E()) =>
  callWorker(new Request(url, init), e);
const skill = async (e: unknown = E()) => {
  const r = await get(`${APP}/skill.md`, {}, e);
  expect(r.status).toBe(200);
  return r.text();
};

/** The frontmatter's top-level scalars and metadata map (the shape we emit). */
function frontmatter(md: string) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (!m?.[1]) throw new Error("no frontmatter");
  const top: Record<string, string> = {};
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = /^(\s*)([\w-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const v = (kv[3] ?? "").startsWith('"')
      ? (JSON.parse(kv[3] ?? "") as string)
      : (kv[3] ?? "");
    (kv[1] ? meta : top)[kv[2] ?? ""] = v;
  }
  return {
    name: top.name ?? "",
    description: top.description ?? "",
    metadata: meta,
  };
}

/** `### name` → that section's text, up to the next heading of level ≤ 3. */
function toolSections(md: string): Map<string, string> {
  const tools = md.split("\n## Tools\n")[1]?.split(/\n## /)[0] ?? "";
  const out = new Map<string, string>();
  for (const part of tools.split(/\n### /).slice(1)) {
    const [name, ...rest] = part.split("\n");
    out.set(name ?? "", rest.join("\n"));
  }
  return out;
}

describe("skill.md drift", () => {
  // skill.generated.ts is gitignored and written by `pnpm gen` before every
  // test run, so these check the emitter, not a committed copy.
  it("the template renders deterministically", () => {
    expect(renderSkillTemplate()).toBe(renderSkillTemplate());
  });

  it("the generated template is a fresh render", () => {
    expect(SKILL_TEMPLATE).toBe(renderSkillTemplate());
  });

  it("the served /skill.md is a fresh render with its tokens filled", async () => {
    const e = E() as Parameters<typeof dataLimits>[0] & { APP_HOST: string };
    const { plan, docBytes } = dataLimits(e);
    const v: Record<string, string> = {
      ...planText(plan, docBytes),
      origin: skillOrigin(e.APP_HOST),
      host: e.APP_HOST,
      name: await skillName(e.APP_HOST),
      hostSlug: hostSlug(e.APP_HOST),
      version: VERSION,
      upgradeLine: upgradeLine(e),
    };
    const fresh = renderSkillTemplate().replace(
      /\{\{(\w+)\}\}/g,
      (m, k: string) => v[k] ?? m,
    );
    expect(await skill()).toBe(fresh);
  });

  it("SKILL_HASH is the template's sha256 prefix", async () => {
    const d = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(SKILL_TEMPLATE),
    );
    const hex = [...new Uint8Array(d)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(SKILL_HASH).toBe(hex.slice(0, 8));
  });

  it("tool headings equal tools/list; every input property is in its section", async () => {
    const u = await login(`skill-${newId().slice(0, 6).toLowerCase()}@x.com`);
    const c = await connect((await createPat(env, u.userId, "s")).token);
    const { tools } = await c.listTools();
    await c.close();
    const sections = toolSections(await skill());
    expect([...sections.keys()].sort()).toEqual(
      tools.map((t) => t.name).sort(),
    );
    for (const t of tools) {
      const line =
        (sections.get(t.name) ?? "")
          .split("\n")
          .find((l) => l.startsWith("Parameters (? = optional): ")) ?? "";
      const listed = [...line.matchAll(/`(\w+)\??`/g)].map((m) => m[1]);
      expect(listed.sort(), t.name).toEqual(
        Object.keys(t.inputSchema.properties ?? {}).sort(),
      );
    }
  });

  it("quota_exceeded is plan-aware; includeDeleted renders as boolean", async () => {
    expect(await skill(E({ PLAN: "free" }))).toContain(
      "hit its daily free-plan limit",
    );
    expect(await skill(E({ PLAN: "paid" }))).toContain(
      "hit a daily Cloudflare limit",
    );
    const md = await skill();
    expect(md).toContain("`includeDeleted?` boolean");
    const list = TOOL_DEFS.find((t) => t.name === "list_artifacts");
    expect(list?.inputSchema.safeParse({ includeDeleted: true }).success).toBe(
      true,
    );
    expect(md).toContain(`tools/list shows the ${TOOL_DEFS.length} tools`);
    // The tool count appears once; the version (e.g. 0.17.0) is not a count.
    expect(
      md
        .replaceAll(VERSION, "")
        .match(new RegExp(`\\b${TOOL_DEFS.length}\\b`, "g")) ?? [],
    ).toHaveLength(1);
  });

  it("has the public interactive artifacts section, after the sharing and live-data sections", async () => {
    const md = await skill();
    const at = md.indexOf("\n## Public interactive artifacts\n");
    expect(at).toBeGreaterThan(md.indexOf("\n## Sharing and visibility\n"));
    expect(at).toBeGreaterThan(md.indexOf("\n## Live data (html artifacts)\n"));
    const section = md.slice(at).split("\n## ")[1] ?? "";
    for (const phrase of [
      '`dataWriters: "editors"`',
      "`data_editors_only`",
      "`viewer.anonId()`",
      "`no_shell`",
      "no presence API",
    ])
      expect(section).toContain(phrase);
  });

  it("every tool example passes its input schema", () => {
    for (const t of TOOL_DEFS) {
      const r = t.inputSchema.safeParse(t.example);
      expect(r.success, `${t.name}: ${r.error?.message}`).toBe(true);
    }
  });

  for (const plan of ["free", "paid"] as Plan[]) {
    it(`states the ${plan} plan's limits, and INSTRUCTIONS agrees`, async () => {
      const md = await skill(E({ PLAN: plan }));
      const doc = sizeText(dataDocLimit(plan));
      const inline = `${LIMITS.inlineBytes / 1024} KB`;
      expect(md).toContain(
        `${doc} per document on this instance (${plan} plan${
          plan === "paid" ? ")" : "; Workers Paid allows 1 MB)"
        }`,
      );
      expect(md).not.toMatch(/\b1024 KB\b/);
      expect(md).toContain(inline);
      expect(md).toContain("25 MB");
      expect(md).toContain("`http://app.localhost/mcp`");
      expect(md).not.toContain("{{");
      expect(frontmatter(md).metadata.plan).toBe(plan);
      const ins = INSTRUCTIONS(plan);
      expect(ins).toContain(`${doc} per document on this instance`);
      expect(ins).toContain(inline);
      expect(ins).toContain("25 MB");
      if (plan === "free") expect(ins).not.toContain("1 MB per document");
    });
  }

  it("says artifacts can link to each other, in the skill and INSTRUCTIONS", async () => {
    const line =
      'Artifacts can link to each other: use the other artifact\'s view URL (<origin>/a/<id>, the url publish_artifact returns, also shown by get_artifact) with target="_blank" rel="noopener". It opens in a new tab in the viewer, where live data works. Whether a visitor can open it depends on that artifact\'s own visibility.';
    expect(await skill()).toContain(line);
    expect(INSTRUCTIONS("free")).toContain(line);
    expect(line).not.toContain("\u2014");
  });

  it("states the effective data-doc limit when DATA_DOC_BYTES overrides it", async () => {
    const md = await skill(
      E({ PLAN: "paid", DATA_DOC_BYTES: String(1536 * 1024) }),
    );
    expect(md).toContain("1536 KB per document on this instance (paid plan)");
    expect(md).toContain("a request body over 1600 KB");
  });

  it("metadata.version is VERSION, as /healthz reports", async () => {
    const fm = frontmatter(await skill());
    const health = (await (await get(`${APP}/healthz`)).json()) as {
      version: string;
    };
    expect(fm.metadata.version).toBe(VERSION);
    expect(health.version).toBe(VERSION);
    expect(fm.metadata.instance).toBe("app.localhost");
  });
});

describe("skill.md frontmatter (agentskills.io)", () => {
  it("name and description are valid, H1 names the host", async () => {
    const md = await skill();
    const fm = frontmatter(md);
    expect(fm.name).toBe("open-artifacts-app-localhost");
    expect(fm.name).toMatch(NAME_RE);
    expect(fm.description.length).toBeGreaterThan(0);
    expect(fm.description.length).toBeLessThanOrEqual(1024);
    expect(fm.description.startsWith("Open Artifacts (app.localhost)")).toBe(
      true,
    );
    expect(md).toContain("\n# Open Artifacts (app.localhost)\n");
  });

  it("a 253-char host still fits: name ≤64 with a hash, description ≤1024", async () => {
    const host = `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.example.com`;
    const md = await renderSkill({
      APP_HOST: host,
      ENVIRONMENT: "production",
      PLAN: "free",
    });
    const fm = frontmatter(md);
    expect(fm.name.length).toBeLessThanOrEqual(SKILL_NAME_MAX);
    expect(fm.name).toMatch(NAME_RE);
    expect(fm.name).toMatch(/-[0-9a-f]{6}$/);
    expect(fm.description.length).toBeLessThanOrEqual(1024);
  });

  it("renderSkill does not memoize a failure", async () => {
    const host = `${"r".repeat(70)}.example.com`; // > 64: hashes the host
    const e = {
      APP_HOST: host,
      ENVIRONMENT: "production",
      PLAN: "free",
    } as const;
    const spy = vi
      .spyOn(crypto.subtle, "digest")
      .mockRejectedValueOnce(new Error("boom"));
    await expect(renderSkill(e)).rejects.toThrow("boom");
    spy.mockRestore();
    expect(frontmatter(await renderSkill(e)).name).toMatch(/-[0-9a-f]{6}$/);
  });

  it("secrets: the PAT line and rules, env-var/header form only", async () => {
    const md = await skill();
    const file = secretFile("pat", { hostSlug: "app-localhost" });
    expect(md).toContain(secretSnippet(file, SECRET_LABELS.pat));
    expect(md).toContain(
      'read -rsp "Open Artifacts token (hidden, then Enter): "',
    );
    expect(md).toContain(
      secretRules({
        file,
        usage: `-H "Authorization: Bearer $(cat ${file})"`,
      }),
    );
    expect(md).not.toContain("--token-file");
  });

  it("client setup is agentClients, with verify and reload per client", async () => {
    const md = await skill();
    const fill = (x: string) =>
      x
        .replaceAll("{{origin}}", "http://app.localhost")
        .replaceAll("{{hostSlug}}", "app-localhost");
    const all = agentClients("{{origin}}/mcp", {
      tokenFile: "~/.open-artifacts/{{hostSlug}}-pat-token",
    });
    expect(all).toHaveLength(9);
    const setup = md.split("\n## Client setup\n")[1]?.split("\n## ")[0] ?? "";
    for (const c of all) {
      expect(setup, `${c.variant}:${c.agent}`).toContain(fill(c.code));
      expect(setup).toContain(`### ${c.agent}\n`);
      expect(setup).toContain(`Verify: ${fill(c.verify ?? "?")}`);
      expect(setup).toContain(`Reload: ${c.reload}`);
      if (c.hint) expect(setup).toContain(`Note: ${fill(c.hint)}`);
    }
    expect(setup).not.toMatch(/oa_pat_/);
    expect(setup).toContain(
      "Token: none. Cursor can't read a token file, so sign in with OAuth.",
    );
    for (const bad of ["OA_TOKEN", "{env:", "${env:", "bearer_token_env_var"])
      expect(md).not.toContain(bad);
  });

  it("origin: https for a real host even on a dev Worker; http only for local hosts", async () => {
    for (const h of [
      "localhost",
      "localhost:8787",
      "app.localhost",
      "app.localhost:8813",
      "127.0.0.1:8787",
      "[::1]:8787",
    ])
      expect(skillOrigin(h)).toBe(`http://${h}`);
    for (const h of ["staging.open-artifacts.com", "localhost.example.com"])
      expect(skillOrigin(h)).toBe(`https://${h}`);
    const md = await renderSkill({
      APP_HOST: "staging.open-artifacts.com",
      ENVIRONMENT: "dev",
      PLAN: "free",
    });
    expect(md).toContain("`https://staging.open-artifacts.com/mcp`");
    expect(md).not.toContain("http://staging.open-artifacts.com");
  });

  it("skillName: slug rules, suffixes, cut with hash", async () => {
    expect(hostSlug("Staging.Open-Artifacts.com:8812")).toBe(
      "staging-open-artifacts-com-8812",
    );
    expect(await skillName("staging.open-artifacts.com")).toBe(
      "open-artifacts-staging-open-artifacts-com",
    );
    expect(await skillName("a.b", "-upgrade")).toBe(
      "open-artifacts-a-b-upgrade",
    );
    const long = `${"x".repeat(50)}.--.${"y".repeat(20)}.com`;
    for (const sfx of ["", "-upgrade", "-migrate"]) {
      const n = await skillName(long, sfx);
      expect(n.length).toBeLessThanOrEqual(SKILL_NAME_MAX);
      expect(n).toMatch(NAME_RE);
      expect(n.endsWith(sfx)).toBe(true);
    }
    // Same host, same name; different hosts with one prefix differ.
    expect(await skillName(long)).toBe(await skillName(long));
    expect(await skillName(`${long}.a`)).not.toBe(await skillName(`${long}.b`));
  });
});

describe("GET /skill.md", () => {
  it("app host: 200 markdown, cacheable, ETag/304, HEAD", async () => {
    const r = await get(`${APP}/skill.md`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(r.headers.get("cache-control")).toBe("public, max-age=300");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("set-cookie")).toBeNull();
    const etag = r.headers.get("etag");
    expect(etag).toBe(`"${VERSION}-free-${SKILL_HASH}"`);
    const nm = await get(`${APP}/skill.md`, {
      headers: { "if-none-match": etag ?? "" },
    });
    expect(nm.status).toBe(304);
    expect(await nm.text()).toBe("");
    // A weak validator (Cloudflare compression) still revalidates.
    const weak = await get(`${APP}/skill.md`, {
      headers: { "if-none-match": `W/${etag}` },
    });
    expect(weak.status).toBe(304);
    const head = await get(`${APP}/skill.md`, { method: "HEAD" });
    expect(head.status).toBe(200);
  });

  it("content host: 404; POST: 405", async () => {
    expect((await get(`${CONTENT}/skill.md`)).status).toBe(404);
    const post = await get(`${APP}/skill.md`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
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
    const r = await get(`${APP}/skill.md`, {}, E({ DB, PLAN: "paid" }));
    expect(r.status).toBe(200);
    expect(touched).toBe(0);
  });

  it("SKILL_MD=off: 404, no MCP resource, no pointer in the instructions", async () => {
    const off = E({ SKILL_MD: "off" });
    expect((await get(`${APP}/skill.md`, {}, off)).status).toBe(404);
    const u = await login(`skoff-${newId().slice(0, 6).toLowerCase()}@x.com`);
    const pat = (await createPat(env, u.userId, "s")).token;
    const c = await connect(pat, { env: off });
    const { resources } = await c.listResources();
    expect(resources.map((x) => x.uri)).not.toContain(SKILL_DOC_URI);
    expect(c.getInstructions()).not.toContain("/skill.md");
    await c.close();
  });

  it("served as the MCP resource openartifacts://docs/skill, linked from the instructions", async () => {
    const u = await login(`skres-${newId().slice(0, 6).toLowerCase()}@x.com`);
    const c = await connect((await createPat(env, u.userId, "s")).token);
    expect(c.getInstructions()).toContain(
      "Full guide: http://app.localhost/skill.md",
    );
    const r = await c.readResource({ uri: SKILL_DOC_URI });
    const body = (r.contents[0] as { text?: string }).text;
    expect(body).toBe(await skill());
    await c.close();
  });
});

describe("query_too_large is documented (review item 23)", () => {
  it("the MCP instructions and the skill name the query cap and its code", async () => {
    const mb = `${LIMITS.queryCollectionBytes / 1024 / 1024} MB`;
    for (const text of [
      INSTRUCTIONS("free"),
      INSTRUCTIONS("paid"),
      await skill(),
    ]) {
      expect(text).toContain("query_too_large");
      expect(text).toContain(`up to ${mb}`);
    }
    expect(SKILL_TEMPLATE).toContain("Keep collections small");
  });
});
