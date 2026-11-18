// DOCS_PREVIEW=1 opens doc creation on staging, as if DOC_SWITCH.creation
// were true; docsAvailable's paid-plan rule still applies (#docs-preview).
import { env } from "cloudflare:workers";
import { newId, R } from "@oa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { DOC_SWITCH, docCreationOpen } from "../../src/services/doc-switch.js";
import { docsAvailable } from "../../src/services/docs-available.js";
import { api, errOf, login } from "../helpers.js";

type Vars = { PLAN?: string; HOSTED?: string; DOCS_PREVIEW?: string };
const vars = env as Vars;
const saved: Vars = {};
const app = createApp();
let owner: { cookie: string };

beforeAll(async () => {
  Object.assign(saved, vars);
  DOC_SWITCH.creation = false;
  owner = await login(`prev-${newId().slice(0, 6).toLowerCase()}@x.com`);
});
afterAll(() => {
  vars.PLAN = saved.PLAN;
  vars.HOSTED = saved.HOSTED;
  vars.DOCS_PREVIEW = saved.DOCS_PREVIEW;
});

async function as<T>(v: Vars, f: () => Promise<T>): Promise<T> {
  const before = { ...vars };
  vars.PLAN = v.PLAN;
  vars.HOSTED = v.HOSTED;
  vars.DOCS_PREVIEW = v.DOCS_PREVIEW;
  try {
    return await f();
  } finally {
    Object.assign(vars, before);
  }
}
const mkDoc = () =>
  api(app, R.artifacts, owner.cookie, {
    method: "POST",
    body: { title: "p", format: "doc", content: "# P\n" },
  });
const me = async () =>
  (
    (await (await api(app, R.me, owner.cookie)).json()) as {
      instance: { docs?: string };
    }
  ).instance;

describe("docCreationOpen", () => {
  it("is off without the switch or the var, on with either", () => {
    expect(docCreationOpen({})).toBe(false);
    expect(docCreationOpen({ DOCS_PREVIEW: "0" })).toBe(false);
    expect(docCreationOpen({ DOCS_PREVIEW: "1" })).toBe(true);
    DOC_SWITCH.creation = true;
    try {
      expect(docCreationOpen({})).toBe(true);
    } finally {
      DOC_SWITCH.creation = false;
    }
  });
});

describe("DOCS_PREVIEW on a deployment", () => {
  it("without it, creation is refused (docs_unavailable) and /me has no docs state", async () => {
    await as({ PLAN: "paid" }, async () => {
      const r = await mkDoc();
      expect(r.status).toBe(400);
      expect((await errOf(r)).code).toBe("docs_unavailable");
      expect((await me()).docs).toBeUndefined();
    });
  });

  it("with DOCS_PREVIEW=1 on a paid install, creation is allowed", async () => {
    await as({ PLAN: "paid", DOCS_PREVIEW: "1" }, async () => {
      const r = await mkDoc();
      expect(r.status, await r.clone().text()).toBe(201);
      expect((await me()).docs).toBe("on");
    });
  });

  it("with DOCS_PREVIEW=1 the paid-plan rule still applies", async () => {
    await as({ PLAN: "free", DOCS_PREVIEW: "1" }, async () => {
      expect(docsAvailable(env as never)).toBe(false);
      const r = await mkDoc();
      expect(r.status).toBe(400);
      expect((await errOf(r)).code).toBe("docs_need_paid");
      expect((await me()).docs).toBe("needs_paid");
    });
  });

  it("any other value is ignored", async () => {
    await as({ PLAN: "paid", DOCS_PREVIEW: "true" }, async () => {
      expect((await mkDoc()).status).toBe(400);
    });
  });
});
