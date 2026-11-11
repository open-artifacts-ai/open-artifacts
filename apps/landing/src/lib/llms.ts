import { type CollectionEntry, getCollection } from "astro:content";
import { GATES, gatesFor, UNRELEASED } from "./release";
import { tools } from "./tools";

export const SITE = "https://open-artifacts.com";

export const SUMMARY =
  "Open Artifacts is an open-source, self-hosted place to keep, version, and share what AI agents make: HTML pages, Markdown docs, code, and PDFs. The user deploys it to their own Cloudflare account and domain, and any AI agent publishes to it. You, the agent, can do the whole setup; the only step for the user is the Cloudflare login. If the user asked you to install or set up this file, optionally 'at', 'on' or 'under' a hostname, they want Open Artifacts installed with that hostname as --app-host. Don't copy or host this file.";

export type Doc = CollectionEntry<"docs">;

export async function docs(): Promise<Doc[]> {
  return (await getCollection("docs")).sort(
    (a, b) => a.data.order - b.data.order,
  );
}

// Fill placeholders and point site links at the Markdown copies agents read.
export function agentMarkdown(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->\n*/g, "")
    .replace(/\]\(\/docs\/([a-z-]+)\/\)/g, `](${SITE}/docs/$1.md)`)
    .trim();
}

// The body of a `## heading` section, up to the next `## ` heading.
export function section(doc: Doc, heading: string): string {
  const body = agentMarkdown(doc.body ?? "");
  const start = body.indexOf(`\n## ${heading}\n`);
  if (start < 0) throw new Error(`${doc.id}.md has no "## ${heading}"`);
  const rest = body.slice(start + heading.length + 5);
  const end = rest.search(/^## /m);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

export function docMarkdown(doc: Doc): string {
  return `# ${doc.data.title}\n\n> ${doc.data.description}\n\n${agentMarkdown(doc.body ?? "")}\n`;
}

// Release-gate markers for the stand-ins the agent files depend on: one TODO
// comment line each, then one OA-UNRELEASED line listing them all.
export async function markerLines(): Promise<string> {
  const active = gatesFor("llms");
  if (active.length === 0) return "";
  const todos = active.map((id) => `<!-- ${GATES[id].todo} -->\n`).join("");
  const labels = active.map((id) => GATES[id].label).join(", ");
  return `${todos}${UNRELEASED}: ${labels}\n\n`;
}

export async function llmsTxt(): Promise<string> {
  const all = await docs();
  const byId = (id: string) => {
    const doc = all.find((d) => d.id === id);
    if (!doc) throw new Error(`missing doc ${id}`);
    return doc;
  };
  const body = [
    "# Open Artifacts",
    `> ${SUMMARY}`,
    "## Set up Open Artifacts for your user",
    section(byId("setup"), "Steps"),
    "## Update an existing install",
    section(byId("upgrade"), "Steps"),
    "## Connect another agent",
    section(byId("connect-agents"), "Steps"),
    `To let agents on your user's machines message each other, install the bus: see ${SITE}/docs/agent-bus.md`,
    "## Tools",
    tools.map((t) => `- \`${t.name}\`: ${t.description}`).join("\n"),
    section(byId("mcp-tools"), "Large files"),
    section(byId("mcp-tools"), "Search freshness"),
    "## Docs",
    [
      ...all.map(
        (d) =>
          `- [${d.data.title}](${SITE}/docs/${d.id}.md): ${d.data.description}`,
      ),
      `- [All docs in one file](${SITE}/llms-full.txt)`,
    ].join("\n"),
  ].join("\n\n");
  return `${await markerLines()}${body}\n`;
}
