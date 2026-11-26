import {
  PageSchema,
  PublishResultSchema,
  R,
  SearchHitSchema,
  VersionInfoSchema,
} from "@oa/shared";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buffered } from "../xt/settled-otp.js";
import { findIndexed } from "./search-settle.js";

const base = process.env.STAGING_URL;
const pat = process.env.STAGING_OWNER_PAT;

// Best-effort cleanup: private artifacts created by this file, soft-deleted afterwards.
const created: string[] = [];
afterAll(async () => {
  for (const id of created) {
    try {
      const d = await fetch(`${base}${R.artifact(id)}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${pat}` },
      });
      if (d.status !== 204)
        console.warn(`smoke cleanup: DELETE ${id} -> ${d.status}`);
    } catch (e) {
      console.warn(`smoke cleanup: DELETE ${id} failed`, e);
    }
  }
});

describe.skipIf(!base || !pat)("staging smoke: search", () => {
  it("publishes, then finds it by a body word (indexing runs in the DO alarm)", async () => {
    const word = `smokesearch${Date.now().toString(36)}`;
    const r = await fetch(`${base}${R.artifacts}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${pat}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "smoke search",
        format: "html",
        content: `<script>hidden()</script><p>${word}</p>`,
      }),
    });
    expect(r.status).toBe(201);
    const { id } = PublishResultSchema.parse(await r.json());
    created.push(id);
    // C3: the body is indexed asynchronously by the artifact DO's alarm. The
    // versions read holds while that job is pending (R.versions wait) and
    // answers when it settles: held asks, then one search, all inside one 60 s
    // budget (search-settle.ts); a PAT that is refused fails at once.
    const auth = { authorization: `Bearer ${pat}` };
    await findIndexed({
      versions: async (wait, signal) => {
        const r = await fetch(`${base}${R.versions(id, undefined, wait)}`, {
          headers: auth,
          signal,
        });
        const b = await buffered(r, signal);
        return { status: b.status, text: await b.text() };
      },
      search: async (signal) => {
        const r = await fetch(`${base}${R.search}?q=${word}`, {
          headers: auth,
          signal,
        });
        const b = await buffered(r, signal);
        return { status: b.status, text: await b.text() };
      },
      indexed: (text) =>
        z.array(VersionInfoSchema).parse(JSON.parse(text))[0]?.textIndexed ===
        true,
      listed: (text) =>
        PageSchema(SearchHitSchema)
          .parse(JSON.parse(text))
          .items.some((h) => h.id === id),
      budgetMs: 60_000,
      holdMs: 25_000,
      quickMax: 5,
    });
    const anon = await fetch(`${base}${R.search}?q=${word}`);
    expect(anon.status).toBe(401);
  }, 75_000);
});
