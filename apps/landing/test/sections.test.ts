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

  it("the default hero is the side-by-side demo, readable without script", () => {
    expect(text).toContain(
      "In a transcript The decision is in there somewhere.",
    );
    expect(text).toContain("In an artifact The decision is at the top.");
    expect(text).toContain(
      "Same work. One is a scroll you search. The other is a page your team works on.",
    );
    expect(text).toContain(
      "A long agent chat transcript where the decision is hard to find, next to the same work as a short page with the decision at the top.",
    );
    expect(text).toContain("> wait, what did we decide?");
    expect(index).toMatch(/class="x-term sbs-term" aria-hidden="true"/);
    expect(index).toMatch(/class="x-blk hit"><h4>Decision<\/h4>/);
    // two comments in the artifact, and no question chips
    const art = index.slice(
      index.indexOf('class="x-art sbs-art"'),
      index.indexOf('class="sbs-cap"'),
    );
    expect(art.match(/class="x-cm"/g)).toHaveLength(2);
    expect(index).not.toContain('data-q="dec"');
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

  it("has a card piece for each chapter on phones", () => {
    const pieces =
      index.match(
        /<div class="mp[ "][^>]*data-mp="(pub|com|ask|live|ver|share|wall)"/g,
      ) ?? [];
    expect(pieces).toHaveLength(7);
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

  it("has no bus, proof or ownership section, and no trace of the old names", () => {
    for (const gone of [
      "Agents that work together.",
      "We build Open Artifacts with Open Artifacts.",
      "Own your work. Share it with anyone.",
      "Milestone triage",
    ])
      expect(text).not.toContain(gone);
    expect(text).not.toMatch(/\bDana\b|\bLeo\b|\bLU\b/);
  });

  it("the Live chapter has a poll that is landed with scripts off, real buttons with aria-pressed", () => {
    expect(text).toContain("Try it: vote, or tick an item");
    expect(text.match(/Which day do we launch\?/g)).toHaveLength(2);
    const poll = index.match(/<div class="poll asm"[\s\S]*?<\/div>/)?.[0] ?? "";
    expect(
      poll.match(/<button type="button" aria-pressed="false">/g),
    ).toHaveLength(3);
    // Wednesday 1, Thursday 3, Friday 0 (4 votes)
    expect(poll).toMatch(
      /Wednesday<\/span><span class="you">Your vote<\/span><b>1<\/b>/,
    );
    expect(poll).toMatch(
      /Thursday<\/span><span class="you">Your vote<\/span><b>3<\/b>/,
    );
    expect(poll).toMatch(
      /Friday<\/span><span class="you">Your vote<\/span><b>0<\/b>/,
    );
    expect(text).toContain("4 votes");
  });

  it("the checklist buttons say if they are pressed", () => {
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

  it("centres the close", () => {
    expect(index).toMatch(/<section class="x-sec x-close"/);
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
