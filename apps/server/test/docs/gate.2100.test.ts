// The self-host gate for collaborative docs (#2100): hosted plans and Workers
// Paid create docs; Workers Free refuses with docs_need_paid and the next
// step; a doc made on paid stays readable, read-only, on free.
import { env } from "cloudflare:workers";
import { newId, R } from "@oa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createPat } from "../../src/auth/pat.js";
import { DOC_SWITCH } from "../../src/services/doc-switch.js";
import { api, errOf, login } from "../helpers.js";
import { close, connect, E, textOf, tool } from "../mcp-helpers.js";

const NEED_PAID =
  "Collaborative docs need Cloudflare's Workers Paid plan when you self-host. Move to Workers Paid, then run setup with --upgrade --plan paid.";

const app = createApp();
type Vars = { PLAN?: string; HOSTED?: string; TIER?: string };
const vars = env as Vars;
const saved: Vars = {};
let owner: { cookie: string; userId: string };
let pat: string;

DOC_SWITCH.creation = true;
beforeAll(async () => {
  saved.PLAN = vars.PLAN;
  saved.HOSTED = vars.HOSTED;
  saved.TIER = vars.TIER;
  owner = await login(`gate-${newId().slice(0, 6).toLowerCase()}@x.com`);
  pat = (await createPat(env, owner.userId, "gate")).token;
});
afterAll(() => {
  Object.assign(vars, saved);
  DOC_SWITCH.creation = false;
});

/** Runs `f` as the deployment `v` (the Worker's vars), then puts them back. */
async function as<T>(v: Vars, f: () => Promise<T>): Promise<T> {
  const before = { ...vars };
  vars.PLAN = v.PLAN;
  vars.HOSTED = v.HOSTED;
  vars.TIER = v.TIER;
  try {
    return await f();
  } finally {
    Object.assign(vars, before);
  }
}

const post = (path: string, body: unknown, bearer = owner.cookie) =>
  api(app, path, bearer, { method: "POST", body });
const mkDoc = (title = "d") =>
  post(R.artifacts, {
    title,
    format: "doc",
    content: "# Goals\n\nShip docs.\n",
  });

describe("hosted plans create docs", () => {
  it.each(["solo", "team", "business"])("hosted %s", async (TIER) => {
    await as({ HOSTED: "1", TIER }, async () => {
      const r = await mkDoc(TIER);
      expect(r.status, await r.clone().text()).toBe(201);
    });
  });
});

describe("a self-host", () => {
  it("on Workers Paid creates a doc", async () => {
    await as({ PLAN: "paid" }, async () => {
      const r = await mkDoc();
      expect(r.status, await r.clone().text()).toBe(201);
    });
  });

  it("on Workers Free refuses a doc and edit_doc with docs_need_paid and the next step", async () => {
    const id = await as({ PLAN: "paid" }, async () => {
      const r = await mkDoc("made on paid");
      return ((await r.json()) as { id: string }).id;
    });
    await as({ PLAN: "free" }, async () => {
      // publish_artifact with format doc, over REST and over MCP.
      const rest = await mkDoc("x");
      expect(rest.status).toBe(400);
      const e = await errOf(rest);
      expect(e.code).toBe("docs_need_paid");
      expect(e.message).toBe(NEED_PAID);
      const c = await connect(pat, { env: E({ PLAN: "free" }) });
      try {
        const out = await c.callTool({
          name: "publish_artifact",
          arguments: { title: "x", format: "doc", content: "# x\n" },
        });
        expect(out.isError).toBe(true);
        expect(textOf(out as never)).toContain("docs_need_paid");
        expect(textOf(out as never)).toContain(NEED_PAID);
      } finally {
        await close(c);
      }
      // edit_doc over REST: the same refusal, nothing applied.
      const edit = await post(R.docOps(id), {
        ops: [{ op: "replace", quote: "Ship docs.", with: "Shipped." }],
      });
      expect(edit.status).toBe(400);
      const ee = await errOf(edit);
      expect(ee.code).toBe("docs_need_paid");
      expect(ee.message).toBe(NEED_PAID);
    });
  });

  it("a doc made on paid stays readable on free; every edit is refused", async () => {
    const id = await as({ PLAN: "paid" }, async () => {
      const r = await mkDoc("kept");
      return ((await r.json()) as { id: string }).id;
    });
    await as({ PLAN: "free" }, async () => {
      // Read: the artifact, its saved file, and get_artifact with content.
      const meta = await api(app, R.artifact(id), owner.cookie);
      expect(meta.status).toBe(200);
      expect(((await meta.json()) as { format: string }).format).toBe("doc");
      const file = await api(app, R.versionFile(id, 1, "doc.md"), owner.cookie);
      expect(file.status).toBe(200);
      expect(await file.text()).toBe("# Goals\n\nShip docs.\n");
      const c = await connect(pat, { env: E({ PLAN: "free" }) });
      try {
        const g = await tool(c, "get_artifact", { id, includeContent: true });
        expect(g.structuredContent?.content).toContain("Ship docs.");
      } finally {
        await close(c);
      }
      // Edits are refused: edit_doc, and a whole-content publish.
      const edit = await post(R.docOps(id), {
        ops: [{ op: "replace", quote: "Ship docs.", with: "Shipped." }],
      });
      expect((await errOf(edit)).code).toBe("docs_need_paid");
      const pub = await post(R.artifacts, {
        id,
        format: "doc",
        content: "# Changed\n",
      });
      expect(pub.status).toBe(400);
      expect(
        await (
          await api(app, R.versionFile(id, 1, "doc.md"), owner.cookie)
        ).text(),
      ).toBe("# Goals\n\nShip docs.\n");
    });
  });

  it("tools/list and the skill hide edit_doc on free, and show it on paid", async () => {
    for (const [PLAN, shown] of [
      ["free", false],
      ["paid", true],
    ] as const) {
      const c = await connect(pat, { env: E({ PLAN }) });
      try {
        const names = (await c.listTools()).tools.map((t) => t.name);
        expect(names.includes("edit_doc"), `tools/list on ${PLAN}`).toBe(shown);
      } finally {
        await close(c);
      }
    }
    const { renderSkill } = await import("../../src/mcp/skill.js");
    const free = await renderSkill(E({ PLAN: "free", HOSTED: "" }));
    expect(free).not.toContain("### edit_doc");
  });
});
