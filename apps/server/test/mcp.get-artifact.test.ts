import { env } from "cloudflare:workers";
import type { Client } from "@modelcontextprotocol/client";
import { newId } from "@oa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPat } from "../src/auth/pat.js";
import { login } from "./helpers.js";
import {
  APP,
  callWorker,
  connect,
  E,
  type ToolResult,
  textOf,
  tool,
} from "./mcp-helpers.js";

// #3165: end-to-end acceptance tests for get_artifact view/find/sinceVersion.

const tag = newId().slice(0, 6).toLowerCase();
let client: Client;

const sc = <T = Record<string, unknown>>(r: ToolResult) => {
  expect(r.isError, textOf(r)).toBeFalsy();
  return r.structuredContent as T;
};

/** Builds a realistic ~15 KB status-page HTML fixture with heavy CSS. */
function buildStatusPageHtml(opts?: {
  billingStatus?: string;
  extraCss?: string;
}): string {
  const billingStatus = opts?.billingStatus ?? "Investigating";
  const cssRules = Array.from(
    { length: 140 },
    (_, i) =>
      `.card-${i} { display: flex; flex-direction: column; padding: 12px 16px; border: 1px solid #e2e8f0; border-radius: 8px; background: #ffffff; color: #0f172a; }`,
  ).join("\n    ");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Platform Status Page</title>
  <style>
    :root { --bg: #f8fafc; --fg: #0f172a; --muted: #64748b; }
    body { margin: 0; font-family: system-ui, sans-serif; background: var(--bg); color: var(--fg); }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 8px 12px; border-bottom: 1px solid #cbd5e1; text-align: left; }
    ${cssRules}
    ${opts?.extraCss ?? ""}
  </style>
</head>
<body>
  <!-- generated status page -->
  <p><a href="https://oa.test/a/parent123">Parent Overview</a></p>
  <h1>Platform Status</h1>
  <p>Updated 2026-11-26 04:00 UTC. All core regions are serving traffic.</p>

  <h2>Open Incidents</h2>
  <table>
    <thead>
      <tr><th>Service</th><th>Owner</th><th>Status</th><th>Runbook</th></tr>
    </thead>
    <tbody>
      <tr><td>API Gateway</td><td>Alice</td><td>Nominal</td><td><a href="https://ops.example.com/api">API Guide</a></td></tr>
      <tr><td>Billing Pipeline</td><td>Bob</td><td>${billingStatus}</td><td><a href="https://ops.example.com/billing">Billing Guide</a></td></tr>
      <tr><td>Search Index</td><td>Carol</td><td>Nominal</td><td><a href="https://ops.example.com/search">Search Guide</a></td></tr>
    </tbody>
  </table>

  <h2>Deploy Queue</h2>
  <ul>
    <li>Worker build 412 queued for staging</li>
    <li>Database migration 0048 verified</li>
  </ul>

  <h2>Quasar Telemetry</h2>
  <p>The quasar collector reported zero dropped frames over the last 24 hours.</p>
  <p>Contact <a href="https://ops.example.com/oncall">On-Call Rotation</a> for escalations.</p>

  <script>
    window.__STATUS_DATA__ = { version: 1, secret: "script-noise" };
    console.log("loaded");
  </script>
</body>
</html>`;
}

beforeAll(async () => {
  const owner = await login(`mcp-get-${tag}@x.com`);
  const pat = (await createPat(env, owner.userId, "reader-agent")).token;
  client = await connect(pat);
});

afterAll(async () => {
  await client?.close();
});

describe("get_artifact view, find, and sinceVersion (#3165)", () => {
  it("returns compact text view (< 1/3 size), targeted find (< 1 KB), and unified diffs", async () => {
    const htmlV1 = buildStatusPageHtml();
    expect(htmlV1.length).toBeGreaterThan(14_000);

    const v1 = sc<{ id: string; version: number }>(
      await tool(client, "publish_artifact", {
        title: `Status ${tag}`,
        format: "html",
        content: htmlV1,
      }),
    );

    // Default behavior unchanged: full raw HTML.
    const raw = sc<{ content?: string }>(
      await tool(client, "get_artifact", { id: v1.id }),
    );
    expect(raw.content).toBe(htmlV1);

    // 1. view: "text" drops CSS/script/markup and is under a third of full size.
    const textRes = sc<{ content?: string }>(
      await tool(client, "get_artifact", { id: v1.id, view: "text" }),
    );
    expect(textRes.content).toBeDefined();
    const text = textRes.content as string;
    expect(text.length).toBeLessThan(htmlV1.length / 3);
    expect(text).toContain("# Platform Status");
    expect(text).toContain("## Open Incidents");
    expect(text).toContain(
      "Billing Pipeline | Bob | Investigating | Billing Guide (https://ops.example.com/billing)",
    );
    expect(text).toContain("- Worker build 412 queued for staging");
    expect(text).not.toContain(".card-0");
    expect(text).not.toContain("script-noise");
    expect(text).not.toContain("generated status page");

    // 2. find for a word in one section is under 1 KB and returns matches count.
    const findRes = sc<{ content?: string; matches?: number }>(
      await tool(client, "get_artifact", { id: v1.id, find: "quasar" }),
    );
    expect(findRes.matches).toBe(2);
    expect(findRes.content).toBeDefined();
    expect((findRes.content as string).length).toBeLessThan(1024);
    expect(findRes.content).toContain("Quasar Telemetry");
    expect(findRes.content).toContain("zero dropped frames");

    // find + view: "text" may combine.
    const comboRes = sc<{ content?: string; matches?: number }>(
      await tool(client, "get_artifact", {
        id: v1.id,
        view: "text",
        find: "quasar",
      }),
    );
    expect(comboRes.matches).toBe(findRes.matches);
    expect(comboRes.content).toBe(findRes.content);

    // 3. sinceVersion: publish v2 with a text change, and v3 with CSS-only change.
    const htmlV2 = buildStatusPageHtml({ billingStatus: "Resolved" });
    await tool(client, "publish_artifact", {
      id: v1.id,
      format: "html",
      content: htmlV2,
    });
    const htmlV3 = buildStatusPageHtml({
      billingStatus: "Resolved",
      extraCss: ".extra { color: green; }",
    });
    await tool(client, "publish_artifact", {
      id: v1.id,
      format: "html",
      content: htmlV3,
    });

    const diff12 = sc<{ content?: string }>(
      await tool(client, "get_artifact", {
        id: v1.id,
        version: 2,
        sinceVersion: 1,
      }),
    );
    expect(diff12.content).toContain("--- v1");
    expect(diff12.content).toContain("+++ v2");
    expect(diff12.content).toContain(
      "-Billing Pipeline | Bob | Investigating | Billing Guide (https://ops.example.com/billing)",
    );
    expect(diff12.content).toContain(
      "+Billing Pipeline | Bob | Resolved | Billing Guide (https://ops.example.com/billing)",
    );
    expect(diff12.content).not.toContain(".card-0");

    // CSS-only change from v2 to v3 yields empty text diff.
    const diff23 = sc<{ content?: string }>(
      await tool(client, "get_artifact", { id: v1.id, sinceVersion: 2 }),
    );
    expect(diff23.content).toBe("No text changes from v2 to v3.");

    // Reject sinceVersion >= requested version.
    const badEq = await tool(client, "get_artifact", {
      id: v1.id,
      sinceVersion: 3,
    });
    expect(badEq.isError).toBe(true);
    expect(textOf(badEq)).toContain("bad_request");

    const badGt = await tool(client, "get_artifact", {
      id: v1.id,
      version: 2,
      sinceVersion: 2,
    });
    expect(badGt.isError).toBe(true);
    expect(textOf(badGt)).toContain("bad_request");

    // Reject sinceVersion combined with find or view.
    const badFind = await tool(client, "get_artifact", {
      id: v1.id,
      sinceVersion: 1,
      find: "quasar",
    });
    expect(badFind.isError).toBe(true);
    expect(textOf(badFind)).toContain("bad_request");

    const badView = await tool(client, "get_artifact", {
      id: v1.id,
      sinceVersion: 1,
      view: "text",
    });
    expect(badView.isError).toBe(true);
    expect(textOf(badView)).toContain("bad_request");
  });

  it("returns markdown unchanged for view: text and searches raw markdown for find", async () => {
    const md = "# Notes\n\nAlpha line\n\nBeta line\n\nGamma line\n";
    const pub = sc<{ id: string }>(
      await tool(client, "publish_artifact", {
        title: `MD ${tag}`,
        format: "markdown",
        content: md,
      }),
    );

    const textRes = sc<{ content?: string }>(
      await tool(client, "get_artifact", { id: pub.id, view: "text" }),
    );
    expect(textRes.content).toBe(md);

    const findRes = sc<{ content?: string; matches?: number }>(
      await tool(client, "get_artifact", { id: pub.id, find: "beta" }),
    );
    expect(findRes.matches).toBe(1);
    expect(findRes.content).toContain("Alpha line");
    expect(findRes.content).toContain("Beta line");
    expect(findRes.content).toContain("Gamma line");
  });

  it("documents view, find, and sinceVersion in tools/list and /skill.md", async () => {
    const { tools } = await client.listTools();
    const def = tools.find((t) => t.name === "get_artifact");
    expect(def?.description).toContain(
      'Use view: "text", find or sinceVersion unless you are editing the HTML.',
    );

    const res = await callWorker(new Request(`${APP}/skill.md`), E());
    expect(res.status).toBe(200);
    const skill = await res.text();
    expect(skill).toContain(
      'Unless you are editing the HTML, read with `view: "text"` (visible text only), `find: "<words>"` (just the matching parts) or `sinceVersion: n` (a diff).',
    );
  });
});
