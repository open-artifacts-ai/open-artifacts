import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Landing v2 sections: decorative motion is aria-hidden, and the same story is
// in real text next to it. Runs against the built site.
const index = readFileSync(
  fileURLToPath(new URL("../dist/index.html", import.meta.url)),
  "utf8",
);
const section = (attr: string) => {
  const start = index.indexOf(attr);
  expect(start, attr).toBeGreaterThan(-1);
  return index.slice(start, index.indexOf("</figure>", start));
};

describe("landing sections", () => {
  it("the agent wiring is decorative, with a real caption", () => {
    const wire = section("data-wire");
    expect(wire).toMatch(/class="wire-stage"[^>]*aria-hidden="true"/);
    for (const agent of [
      "Claude Code",
      "Codex",
      "Cursor",
      "OpenCode",
      "Any MCP client",
    ])
      expect(wire).toContain(`>${agent}</li>`);
    expect(wire).toMatch(/<figcaption[^>]*>\s*Any AI agent sends/);
  });

  it("the chat demo has six keyboard tabs and real prompt text", () => {
    const tabs = index.match(/<button[^>]*role="tab"[^>]*>/g) ?? [];
    expect(tabs).toHaveLength(6);
    expect(index).toMatch(/role="tablist"[^>]*aria-label="Examples"/);
    expect(index).toMatch(/id="demo-panel"[^>]*role="tabpanel"/);
    expect(
      /<span class="sr-only"[^>]*>publish this as an artifact<\/span>/.test(
        index,
      ),
    ).toBe(true);
    expect(index.match(/data-k="/g)).toHaveLength(16);
  });

  it("the feature story is four real features with aria-hidden mocks", () => {
    const story = index.slice(index.indexOf("data-story"));
    expect(story.match(/class="story-item"/g)).toHaveLength(4);
    expect(
      story.match(/class="story-slot"[^>]*aria-hidden="true"/g),
    ).toHaveLength(4);
    expect(story).toMatch(/class="story-stage"[^>]*aria-hidden="true"/);
    for (const badge of ["From Claude Code", "From Cursor", "From Codex"])
      expect(story).toContain(badge);
    expect(story).toContain("Restore this version");
  });

  it("the gallery has six working tiles and an accessible viewer", () => {
    const gallery = index.slice(index.indexOf("data-gallery"));
    expect(gallery.match(/<article[^>]*data-tile/g)).toHaveLength(6);
    expect(gallery.match(/aria-haspopup="dialog"/g)).toHaveLength(6);
    expect(gallery).toMatch(/<dialog[^>]*aria-labelledby="vw-title"/);
    for (const title of [
      "Publishing dashboard",
      "Sprint 41 retro poll",
      "Mortgage calculator",
      "backfill.py",
    ])
      expect(gallery).toContain(`aria-label="Open ${title}"`);
  });

  it("the hero headline is two fixed lines, and the subcopy links the repo", () => {
    expect(index).toMatch(
      /<h1[^>]*>\s*<span[^>]*>Bring any agent\.<\/span>\s*<span[^>]*>Keep every artifact\.<\/span>\s*<\/h1>/,
    );
    const lede = index.slice(
      index.indexOf('class="lede"'),
      index.indexOf("</p>", index.indexOf('class="lede"')),
    );
    expect(lede).toMatch(
      /<a href="https:\/\/github\.com\/open-artifacts-ai\/open-artifacts"[^>]*>open source<\/a>/,
    );
    // #421: the hero leads with Open Artifacts; Cloudflare is only the self-host path.
    expect(lede).not.toContain("Cloudflare");
    expect(index).not.toContain("For Free. Seriously.");
  });

  it("without HOSTED_SIGNUP_URL, self-host is the only, primary, hero button", () => {
    const actions = index.slice(
      index.indexOf('class="hero-actions"'),
      index.indexOf("</div>", index.indexOf('class="hero-actions"')),
    );
    expect(actions).not.toContain("Get started free");
    expect(actions).toMatch(
      /<a class="btn lg primary"[^>]*href="#self-host"[^>]*>Self-host it<\/a>/,
    );
    expect(index).toMatch(/<section class="band" id="self-host"/);
  });

  it("the setup prompt sits with the self-host mention, and Cloudflare is named there", () => {
    const cta = index.slice(
      index.indexOf('class="cta"'),
      index.indexOf('class="cta-note"'),
    );
    expect(cta).toContain(
      "Self-hosting runs in your own Cloudflare account. Tell your agent:",
    );
    expect(cta).toContain('data-copy="install open-artifacts.com/llms.txt"');
  });

  it("the gallery is a carousel with labeled prev and next", () => {
    expect(index).toMatch(/data-wall[^>]*tabindex="0"[^>]*role="region"/);
    expect(index).toContain('aria-label="Previous artifacts"');
    expect(index).toContain('aria-label="Next artifacts"');
  });

  it("the copy button copies the unambiguous setup phrase", () => {
    expect(index).toContain('data-copy="install open-artifacts.com/llms.txt"');
    expect(index).not.toMatch(/set up open-artifacts\.com/i);
  });

  it("the hero keeps the library screenshot", () => {
    expect(index).toMatch(/class="frame hero-shot"/);
  });

  it("the multiplayer section is two viewers of one artifact, using the real API", () => {
    const start = index.indexOf('id="multi-h"');
    expect(start).toBeGreaterThan(-1);
    const multi = index.slice(start, index.indexOf("</section>", start));
    const wins = multi.match(/<figure[^>]*data-who="(Ana|Sam)"/g) ?? [];
    expect(wins).toHaveLength(2);
    expect(
      multi.match(/artifacts\.example\.com\/a\/<b[^>]*>Tq7mW4<\/b>/g),
    ).toHaveLength(2);
    expect(multi.match(/type="checkbox"/g)).toHaveLength(10);
    expect(multi).toMatch(/role="status"[^>]*aria-live="polite"/);
    expect(multi).toContain("Durable Object");
    const code = multi.replace(/<[^>]+>/g, "");
    for (const call of [
      "openArtifacts.ready",
      "openArtifacts.viewer.get()",
      'openArtifacts.db.collection("todos")',
      "todos.subscribe(({ docs })",
      "todos.update(id, {",
    ])
      expect(code).toContain(call);
  });

  it("no presence wording: the runtime has no presence API", () => {
    const text = index.replace(
      /<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g,
      "",
    );
    for (const claim of [
      /people here/i,
      /\bonline now\b/i,
      /\bwho(?:'s| is) here\b/i,
      /\blive users?\b/i,
      /\bpresence\b/i,
      /\bis typing\b/i,
      /\bviewing now\b/i,
    ])
      expect(text).not.toMatch(claim);
  });
});
