import type { Page } from "@playwright/test";
import {
  APP,
  artifactFrame,
  expect,
  publishViaApi,
  test,
  uniq,
} from "./fixtures";

// Two tabs of one browser, opened at once with no anonymous token yet, must
// end up with ONE anonId, and keep it across a reload: the demos key seats
// and votes on it, so an id that changes on reload loses the seat.
const ID_PAGE = `<!doctype html>
<p id="me">loading</p>
<script>
const oa = window.openArtifacts;
oa.ready
  .then(() => oa.viewer.anonId())
  .then((id) => { document.getElementById("me").textContent = id || "none"; })
  .catch((e) => { document.getElementById("me").textContent = "error:" + e.message; });
</script>`;

const ID_RE = /^[A-Za-z0-9_-]{8}$/;

async function idOf(page: Page): Promise<string> {
  const me = artifactFrame(page).locator("#me");
  await expect(me).not.toHaveText("loading");
  return (await me.textContent()) ?? "";
}

test("tabs opened at once share one anonId that survives a reload", async ({
  browser,
  member,
}) => {
  const { id } = await publishViaApi(member.pat, {
    title: `Anon tabs ${uniq()}`,
    format: "html",
    content: ID_PAGE,
    visibility: "public",
    allowAnonymousWrites: true,
    capabilities: { db: true, viewer: true },
  });
  const ctx = await browser.newContext({ baseURL: APP });
  const tabs = await Promise.all([0, 1, 2].map(() => ctx.newPage()));
  await Promise.all(tabs.map((t) => t.goto(`/a/${id}`)));
  const first = await Promise.all(tabs.map(idOf));
  for (const v of first) expect(v).toMatch(ID_RE);
  await Promise.all(tabs.map((t) => t.reload()));
  const after = await Promise.all(tabs.map(idOf));
  expect({ first, after }).toEqual({
    first: [first[0], first[0], first[0]],
    after: [first[0], first[0], first[0]],
  });
  await ctx.close();
});
