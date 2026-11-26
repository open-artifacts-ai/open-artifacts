import {
  PageSchema,
  PublishResultSchema,
  R,
  SearchHitSchema,
  VersionInfoSchema,
} from "@oa/shared";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

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
    // versions read holds while that job is pending and answers when it
    // settles (R.versions wait), so there is one held ask, then one search.
    // Each ask has its own bound; a refused PAT (401/403) fails at once.
    const HOLD_MS = 25_000;
    const deadline = Date.now() + 90_000;
    let quick = 0;
    for (;;) {
      const asked = Date.now();
      const v = await fetch(`${base}${R.versions(id, undefined, HOLD_MS)}`, {
        headers: { authorization: `Bearer ${pat}` },
        signal: AbortSignal.timeout(HOLD_MS + 10_000),
      });
      const text = await v.text();
      expect(v.status, `versions: ${text}`).toBe(200);
      const newest = z.array(VersionInfoSchema).parse(JSON.parse(text))[0];
      if (newest?.textIndexed) break;
      if (Date.now() >= deadline)
        throw new Error(`not indexed in 90 s; last versions: ${text}`);
      // An install that answers at once, again and again, does not hold the
      // request (an older build): fail rather than ask in a tight loop.
      quick = Date.now() - asked < HOLD_MS / 2 ? quick + 1 : 0;
      if (quick > 5)
        throw new Error(
          "versions?wait answers without holding: an install without the wait param",
        );
    }
    const s = await fetch(`${base}${R.search}?q=${word}`, {
      headers: { authorization: `Bearer ${pat}` },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await s.text();
    expect(s.status, `search: ${body}`).toBe(200);
    const page = PageSchema(SearchHitSchema).parse(JSON.parse(body));
    expect(
      page.items.some((h) => h.id === id),
      `search: ${body}`,
    ).toBe(true);
    const anon = await fetch(`${base}${R.search}?q=${word}`);
    expect(anon.status).toBe(401);
  }, 130_000);
});
