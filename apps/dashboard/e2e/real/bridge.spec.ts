import { artifactFrame, expect, publishViaApi, test, uniq } from "./fixtures";

// The runtime (packages/runtime) is injected into every HTML artifact.
const DB_PAGE = `<!doctype html>
<p id="out">loading</p><button id="save">Save</button>
<script>
const out = document.getElementById("out");
const notes = () => window.openArtifacts.db.collection("notes");
window.openArtifacts.ready
  .then(() => notes().get("n1"))
  .then((d) => { out.textContent = d ? "loaded:" + d.data.text : "empty"; })
  .catch((e) => { out.textContent = "error:" + e.message; });
document.getElementById("save").onclick = () =>
  notes().set("n1", { text: "hello" })
    .then(() => { out.textContent = "saved"; })
    .catch((e) => { out.textContent = "error:" + e.message; });
</script>`;

test("db-capable HTML artifact sets/gets a doc via window.openArtifacts and it persists after reload", {
  tag: "@smoke",
}, async ({ page, member }) => {
  const { id } = await publishViaApi(member.pat, {
    title: `Notes app ${uniq()}`,
    format: "html",
    content: DB_PAGE,
    capabilities: { db: true },
  });
  await page.goto(`/a/${id}`);
  const out = artifactFrame(page).locator("#out");
  await expect(out).toHaveText("empty");
  await artifactFrame(page).getByRole("button", { name: "Save" }).click();
  await expect(out).toHaveText("saved");
  await page.reload();
  await expect(out).toHaveText("loaded:hello");
});

test("viewer iframe has the exact sandbox attribute", async ({
  page,
  member,
}) => {
  const { id } = await publishViaApi(member.pat, {
    title: `Sandbox ${uniq()}`,
    format: "html",
    content: "<p>hi</p>",
  });
  await page.goto(`/a/${id}`);
  await expect(page.locator("iframe.oa-vframe")).toHaveAttribute(
    "sandbox",
    "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads",
  );
});
