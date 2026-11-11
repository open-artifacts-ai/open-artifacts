import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The landing page (#1457), read from the built HTML: no script runs here, so
// everything below is what a reader gets with scripts off.
const index = readFileSync(
  fileURLToPath(new URL("../dist/index.html", import.meta.url)),
  "utf8",
);
const text = index
  .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "")
  .replace(/<[^>]+>/g, " ")
  .replace(/&#39;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/&gt;/g, ">")
  .replace(/&amp;/g, "&")
  .replace(/\s+/g, " ");

describe("landing sections", () => {
  it("renders every section heading without JS", () => {
    for (const h of [
      "Stop reading transcripts.",
      "Transcripts are a bad place to do work.",
      "Ask your agent to publish.",
      "Comment where it matters.",
      "Decide with one click.",
      "Work on it together, live.",
      "Every publish is a version.",
      "Share it with anyone.",
      "One place for everything your agents make.",
      "Agents that work together.",
      "We build Open Artifacts with Open Artifacts.",
      "Own your work. Share it with anyone.",
      "Simple pricing.",
      "Self-host in three steps.",
      "Where people and agents come to do their best work, together.",
    ])
      expect(text, h).toContain(h);
    expect(index).toMatch(/<h1[^>]*>Stop reading transcripts\.<\/h1>/);
  });

  it("has the title the hand-off asks for", () => {
    expect(index).toContain(
      "<title>Open Artifacts: stop reading transcripts</title>",
    );
  });

  it("shows both before and after panels in their landed state", () => {
    expect(text).toContain("9 messages back, and even the agent isn't sure.");
    expect(text).toContain("At the top of the page.");
    expect(index).toMatch(/<p class="[^"]*hit[^"]*" data-tag="dec"/);
    expect(index).toMatch(/class="x-blk hit" id="b-dec"/);
    for (const q of [
      "What did we decide?",
      "What changed?",
      "What does the team think?",
    ])
      expect(index).toMatch(
        new RegExp(
          `<button[^>]*data-q="[a-z]+"[^>]*aria-pressed="(true|false)"[^>]*>${q.replace("?", "\\?")}</button>`,
        ),
      );
    expect(index).toMatch(/aria-pressed="true"[^>]*>Claude Code<\/button>/);
    expect(index).toMatch(/aria-pressed="false"[^>]*>Codex<\/button>/);
  });

  it("says once that the demo replies are scripted", () => {
    expect(text.match(/are scripted/g)).toHaveLength(1);
  });

  it("every chapter's text is in the HTML, in order, with a rail of real buttons", () => {
    const chapters = index.match(/<section class="ch">/g) ?? [];
    expect(chapters).toHaveLength(7);
    const rail = index.slice(index.indexOf('id="rail"'));
    expect(
      rail.slice(0, rail.indexOf("</div>")).match(/<button type="button">/g),
    ).toHaveLength(7);
    expect(index).toMatch(
      /aria-pressed="false"[^>]*>Hacker News post|data-k="a" aria-pressed="false"/,
    );
  });

  it("has a card piece for each chapter on phones, and the button to the artifact side", () => {
    const pieces =
      index.match(
        /<div class="mp[ "][^>]*data-mp="(pub|com|ask|live|ver|share|wall)"/g,
      ) ?? [];
    expect(pieces).toHaveLength(7);
    expect(index).toMatch(
      /<button[^>]*class="x-nudge"[^>]*>Now see it in an artifact<\/button>/,
    );
  });

  it("the wall's release tile is a made-up team's, not our roadmap", () => {
    for (const row of [
      "Search filters shipped",
      "Saved views in review",
      "Dark mode building",
    ])
      expect(text).toContain(row);
    expect(text).not.toContain("Comments on PDFs");
    expect(text).not.toContain("Custom domains your pick");
  });

  it("the home header links Pricing, Self-host, Docs and GitHub", () => {
    const nav =
      index.match(
        /<nav aria-label="Site" class="nav-home">[\s\S]*?<\/nav>/,
      )?.[0] ?? "";
    expect(nav).toContain('<a href="#pricing">Pricing</a>');
    expect(nav).toContain('<a href="#self-host">Self-host</a>');
    expect(nav).toContain('<a href="/docs/setup/">Docs</a>');
    expect(nav).toMatch(
      /<a class="gh" href="https:\/\/github\.com[^"]*">GitHub<\/a>/,
    );
  });

  it("the home footer says only Open Artifacts. Open source, MIT licensed.", () => {
    expect(index).toContain(
      "<p>Open Artifacts. Open source, MIT licensed.</p>",
    );
    expect(index).not.toContain("runs on your own Cloudflare account");
  });

  it("the phone chapter buttons say what to try", () => {
    expect(text).toContain("Try it: turn on the public link");
  });

  it("the proof thread names a made-up person, and the checklist buttons say if they are pressed", () => {
    expect(text).toContain("Dana Is the pin work already done?");
    expect(text).not.toMatch(/\bLeo\b|\bLU\b/);
    const list = index.match(/<ul class="cl asm"[\s\S]*?<\/ul>/)?.[0] ?? "";
    expect(
      list.match(/<button type="button" aria-pressed="false">/g),
    ).toHaveLength(5);
  });

  it("shows no presence, export, drawing or collaborative-doc claims", () => {
    for (const claim of [
      /people here/i,
      /\bviewing now\b/i,
      /\bonline now\b/i,
      /\b\d+ viewing\b/i,
      /\bpresence\b/i,
      /\bexport\b/i,
      /\bdraw(ing)?\b/i,
      /collaborative docs?/i,
    ])
      expect(text).not.toMatch(claim);
  });

  it("leaves the unconfirmed founder quote out", () => {
    expect(index).not.toContain("<blockquote");
    expect(text).not.toContain("I hold one vision");
  });

  it("keeps the three self-host steps and the jump to them", () => {
    expect(index).toMatch(/<section[^>]*id="self-host"/);
    for (const step of [
      "Tell your agent",
      "Sign in to Cloudflare",
      "Publish and share",
    ])
      expect(index).toContain(`<h3>${step}</h3>`);
    expect(index).toContain("<code>npx wrangler login</code>");
    expect(index).toMatch(/<a class="btn" href="#self-host">Self-host it<\/a>/);
  });
});
