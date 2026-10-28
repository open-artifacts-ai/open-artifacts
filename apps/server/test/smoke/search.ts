import {
  PageSchema,
  PublishResultSchema,
  R,
  SearchHitSchema,
} from "@oa/shared";
import { afterAll, describe, expect, it } from "vitest";

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
    // C3: the body is indexed asynchronously by the artifact DO's alarm.
    let found = false;
    let last = "";
    const deadline = Date.now() + 60_000;
    for (;;) {
      // A transient non-200 or a timed-out poll is "not yet" until the
      // deadline; a 401/403 (the PAT itself refused) fails at once.
      let status = 0;
      try {
        const s = await fetch(`${base}${R.search}?q=${word}`, {
          headers: { authorization: `Bearer ${pat}` },
          signal: AbortSignal.timeout(10_000),
        });
        status = s.status;
        last = `${s.status} ${await s.text()}`;
      } catch (e) {
        last = `error ${(e as Error).name}`;
      }
      expect([401, 403], last).not.toContain(status);
      if (status === 200) {
        const page = PageSchema(SearchHitSchema).parse(
          JSON.parse(last.slice(4)),
        );
        found = page.items.some((h) => h.id === id);
      }
      if (found || Date.now() >= deadline) break;
      await new Promise((res) => setTimeout(res, 2_000));
    }
    expect(found, `not found in 60 s; last search response: ${last}`).toBe(
      true,
    );
    const anon = await fetch(`${base}${R.search}?q=${word}`);
    expect(anon.status).toBe(401);
  }, 75_000);
});
