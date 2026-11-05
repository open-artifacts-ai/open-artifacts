import { MCP_PATH } from "@oa/shared";
import { APP, expect, test, uniq } from "./fixtures";

test("a token created in Settings works with /mcp tools/list", async ({
  page,
  member: _,
}) => {
  const label = `ci-${uniq()}`;
  await page.goto("/settings/connections");
  await page.getByRole("button", { name: "Create token" }).click();
  const dialog = page.getByRole("dialog", { name: "Create token" });
  await dialog.getByRole("textbox", { name: "Label" }).fill(label);
  await dialog.getByRole("button", { name: "Create" }).click();
  const created = page.getByRole("dialog", { name: "Token created" });
  // The token sits outside every snippet block (#148).
  const code = created.locator("code.oa-token");
  await expect(code).toHaveText(/^oa_pat_[1-9A-HJ-NP-Za-km-z]{32}$/);
  const token = (await code.textContent()) ?? "";

  // JSON-RPC over Streamable HTTP: the reply may be JSON or one SSE message.
  const res = await fetch(`${APP}${MCP_PATH}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const text = await res.text();
  expect(res.status, text).toBe(200);
  const json = res.headers.get("content-type")?.includes("text/event-stream")
    ? (text.match(/^data: (.*)$/m)?.[1] ?? "")
    : text;
  const reply = JSON.parse(json) as {
    id: number;
    result: { tools: { name: string }[] };
  };
  expect(reply.id).toBe(1);
  expect(reply.result.tools.map((t) => t.name)).toContain("publish_artifact");

  await created.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText(label, { exact: true })).toBeVisible();
});
