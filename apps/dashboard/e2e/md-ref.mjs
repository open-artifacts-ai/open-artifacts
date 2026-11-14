// The reference for e2e/doc-editor-shots.spec.ts: the doc room's sample
// Markdown rendered the way a Markdown artifact is (packages/render: the same
// markdown-it plugins and options, and its theme.css), as { html, css } JSON.
// The theme's .oa-doc is renamed .oa-ref so it can sit inside the dashboard.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SAMPLE } from "./doc-room.mjs";

const render = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/render",
);
const require = createRequire(join(render, "package.json"));
const MarkdownIt = require("markdown-it");
const taskLists = require("markdown-it-task-lists");
const footnote = require("markdown-it-footnote");
const md = new MarkdownIt({ html: false, linkify: true, typographer: false })
  .use(taskLists, { enabled: false, label: false })
  .use(footnote);
const css = readFileSync(join(render, "src/theme.css"), "utf8")
  .replace(/@import[^;]*;/, "")
  .replace(/\.oa-doc\b/g, ".oa-ref");
process.stdout.write(JSON.stringify({ html: md.render(SAMPLE), css }));
