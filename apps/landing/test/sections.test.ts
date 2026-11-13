import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GEMINI_MARK } from "../src/lib/copy";

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
      "Comment where it matters.",
      "Your agent asks. You decide.",
      "The right person decides.",
      "Every decision, on the record.",
      "Work on it together, live.",
      "Every publish is a version.",
      "Share it with anyone.",
      "One place for everything your agents make.",
      "Works with the agents you already use.",
      "Simple pricing.",
      "Self-host in three steps.",
      "Where people and agents come to do their best work, together.",
    ])
      expect(text, h).toContain(h);
    expect(index).toMatch(/<h1[^>]*>Stop reading transcripts\.<\/h1>/);
  });

  it("has the title and OA Product's description", () => {
    expect(index).toContain(
      "<title>Open Artifacts: where people and agents do their best work</title>",
    );
    const desc =
      index.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "";
    expect(desc).toBe(
      "Your agents put their work in an artifact. Your team reads it, comments and decides. Open source, works with any agent.",
    );
    expect(index).toContain(
      '<meta property="og:title" content="Open Artifacts: where people and agents do their best work"',
    );
    expect(index).toContain(
      '<meta name="twitter:title" content="Open Artifacts: where people and agents do their best work"',
    );
    expect(index).not.toContain("stop reading transcripts</title>");
    expect(desc.length).toBeLessThanOrEqual(160);
    expect(desc).not.toContain("Google Docs");
  });

  it("has the link-preview tags for the home page", () => {
    const meta = (k: string, v: string) =>
      index.match(new RegExp(`<meta ${k}="${v}" content="([^"]*)"`))?.[1];
    expect(meta("property", "og:image")).toBe(
      "https://open-artifacts.com/og-home.png",
    );
    expect(meta("name", "twitter:image")).toBe(
      "https://open-artifacts.com/og-home.png",
    );
    expect(meta("name", "twitter:card")).toBe("summary_large_image");
    expect(meta("property", "og:image:width")).toBe("1200");
    expect(meta("property", "og:image:height")).toBe("630");
    const alt =
      "Open Artifacts. Where people and agents do their best work. A launch plan artifact with a decision, comments and an ask.";
    expect(meta("property", "og:image:alt")).toBe(alt);
    expect(meta("name", "twitter:image:alt")).toBe(alt);
    const png = readFileSync(
      fileURLToPath(new URL("../dist/og-home.png", import.meta.url)),
    );
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
  });

  it("launch strings: Join the waitlist everywhere, the trial line under the hero buttons", () => {
    expect(index.match(/>Join the waitlist<\/a>/g)).toHaveLength(5);
    expect(text).toContain(
      "Hosted is invite-only during the beta. Solo is free for 30 days, no card needed. Open source, MIT licensed.",
    );
    for (const gone of [
      "Start free",
      "Then $1 a month",
      "free first month",
      "Free during the private beta",
    ])
      expect(text).not.toContain(gone);
    expect(text).toContain("Sign-ups open in December. This plan");
    expect(text).toContain(
      "Connect one or several. They publish to the same place, and they all get your comments.",
    );
    expect(text).toContain(
      "Set up Open Artifacts: open-artifacts.com/llms.txt",
    );
  });

  it("the hero has the lead line, the question and the cue under the buttons", () => {
    expect(index).toContain(
      '<p class="lede lead1">Create artifacts just like Google Docs</p>',
    );
    expect(text).toContain(
      "You work with a mix of agents and people, so why is collaborating between all of them so hard?",
    );
    expect(text).not.toContain(
      "Works with Claude, Codex, Gemini or any agent.",
    );
    const hero = index.slice(index.indexOf('<header class="hero"'));
    expect(hero.indexOf('class="btns"')).toBeLessThan(
      hero.indexOf('class="cue hcue"'),
    );
    expect(text).toContain(
      "Scroll to see the same work in a transcript and in an artifact.",
    );
  });

  it("the hero scene is nine steps, stacked and readable without script", () => {
    expect(index).toMatch(
      /id="sc" role="group" aria-label="The same work in a transcript and in an artifact, step by step"/,
    );
    const cards = index.match(/<ol class="sc-cards"[\s\S]*?<\/ol>/)?.[0] ?? "";
    expect(cards.match(/<li>\s*<span class="n">/g)).toHaveLength(4);
    for (const n of [1, 2, 3, 4])
      expect(cards.match(/<i class=on>/g)?.length).toBeGreaterThanOrEqual(n);
    expect(cards).not.toMatch(/\d of 9/);
    for (const moment of [
      "You ask a question.",
      "The agent works.",
      "A teammate weighs in.",
      "A week later: what did we decide?",
    ])
      expect(text).toContain(moment);
    // the turn is a small unnumbered card between steps 4 and 5
    expect(cards).toMatch(/<li class="sc-turncard">/);
    expect(text).toContain("That's the last time you scroll for it.");
    expect(text).toContain(
      "From here on there is no transcript. The work happens on the artifact.",
    );
    // the last moment lands on the decision, in both panels
    expect(text).toContain("The decision is in there somewhere.");
    expect(text).toContain("The decision is at the top.");
    expect(text).toContain("Launch day is Thursday, Dec 4.");
    expect(text).toContain("> wait, what did we decide?");
    expect(text).toContain(
      "Same work. One is a scroll you search. The other is a page your team works on.",
    );
  });

  it("has no problem section and no old hero variants", () => {
    expect(text).not.toContain("Transcripts are a bad place to do work.");
    expect(text).not.toContain("forgets it after compaction");
    expect(index).not.toContain('class="x-sec x-problem"');
    expect(index).not.toContain('id="ba"');
    expect(index).not.toContain('id="sbs"');
    expect(index).not.toContain('data-q="dec"');
  });

  it("says once that the demo replies are scripted, under the scene", () => {
    expect(text.match(/are scripted/g)).toHaveLength(1);
    expect(index).toMatch(
      /<p class="x-note">The agent replies in these demos are scripted\.<\/p>/,
    );
  });

  it("the story is chapters 5 to 11 of 11, without weekdays, in order, with a rail of real buttons", () => {
    const chapters = index.match(/<section class="ch">/g) ?? [];
    expect(chapters).toHaveLength(7);
    expect(text).not.toMatch(/\d of 9/);
    const marks =
      index.match(/<section class="ch">[\s\S]*?<\/span><\/span>/g) ?? [];
    expect(marks.map((m) => m.match(/<i class=on>/g)?.length)).toEqual([
      5, 6, 7, 8, 9, 10, 11,
    ]);
    expect(index).not.toMatch(
      /<span class="n">(Monday|Tuesday|Wednesday|Thursday|Friday|Launch day|After that)<\/span>/,
    );
    expect(text).not.toContain("Ask your agent to publish.");
    expect(text).toContain(
      "A comment sits on the line it is about. Mention your agent and it answers in the thread, then changes the artifact.",
    );
    const rail = index.slice(index.indexOf('id="rail"'));
    expect(
      rail.slice(0, rail.indexOf("</div>")).match(/<button type="button">/g),
    ).toHaveLength(7);
    // the rail says what each chapter is
    const labels = [
      ...rail
        .slice(0, rail.indexOf("</div>"))
        .matchAll(/<button type="button">([^<]+)<\/button>/g),
    ].map((m) => m[1]);
    expect(labels).toEqual([
      "Comment",
      "Ask",
      "Team",
      "Record",
      "Live",
      "Versions",
      "Share",
    ]);
  });

  it("the ask chapter is three: ask, team and record, with short captions for phones", () => {
    for (const h of [
      "Your agent asks. You decide.",
      "The right person decides.",
      "Every decision, on the record.",
    ])
      expect(text).toContain(h);
    // each of the three has a short form of its caption, for the locked phone screen
    expect(index).toContain(
      'data-short="Your agent asks on the page, with options. Pick one, or answer in your own words."',
    );
    expect(index).toContain(
      'data-short="Each ask names who decides. Others weigh in, or you pass it on."',
    );
    expect(index).toContain(
      'data-short="Answered asks stay with the page: what, who and when."',
    );
    // the ask offers "Something else"; the team card says who decides, and can pass it on
    expect(
      index.match(/<b>Something else<\/b>/g)?.length,
    ).toBeGreaterThanOrEqual(2);
    expect(text).toContain("You decide");
    expect(text).toContain("Sam and Priya weigh in");
    expect(text).toContain("Not mine to decide");
    // the record: tabs and three rows
    expect(text).toContain("Comments 12 Decisions 3");
    for (const q of [
      "Which channel goes first on launch day?",
      "Monthly or yearly shown first?",
      "Ship the beta Friday?",
    ])
      expect(text).toContain(q);
  });

  it("the share step lists Sam Rivera and Maya Chen, not a third name", () => {
    const share = index.slice(index.indexOf('data-mp="share"'));
    expect(share).toContain("Maya Chen");
    expect(share).toContain("Sam Rivera");
    expect(index).not.toContain("Jonas Weber");
  });

  it("the hero artifact is drawn like the real viewer, and reads with scripts off", () => {
    const cards = index.match(/<ol class="sc-cards"[\s\S]*?<\/ol>/)?.[0] ?? "";
    // top bar, title, byline, timeline, checklist, comments pane, decision
    for (const part of [
      'class="x-abar"',
      'class="sa-h1">Q4 launch plan',
      "OA Product, for Maya Chen",
      "<h4>Timeline</h4>",
      "<h4>Launch checklist</h4>",
      'class="sa-pane"',
      "Launch day is Thursday, Dec 4.",
    ])
      expect(cards).toContain(part);
  });

  it("the stage carries one pinned story: a caption column the script fills", () => {
    expect(index).toContain('id="capcol"');
    expect(index).toContain('id="dec0"');
    expect(index).toContain('id="thread0"');
  });

  it("has a card piece for each chapter on phones", () => {
    const pieces =
      index.match(
        /<div class="mp[ "][^>]*data-mp="(com|ask|team|dec|live|ver|share)"/g,
      ) ?? [];
    expect(pieces).toHaveLength(7);
  });

  it("the wall is an ordinary section after the story, with Product's release tile", () => {
    const wall = index.slice(index.indexOf('id="everything"'));
    expect(wall.indexOf("Release status")).toBeGreaterThan(-1);
    expect(index.indexOf('id="everything"')).toBeGreaterThan(
      index.indexOf('id="story"'),
    );
    expect(index.indexOf('id="everything"')).toBeLessThan(
      index.indexOf('id="agents"'),
    );
    for (const row of [
      "Search filters shipped",
      "Saved views in review",
      "Dark mode building",
    ])
      expect(text).toContain(row);
    expect(text).not.toContain("Comments on PDFs");
    expect(text).not.toContain("Launch email");
    expect(text).not.toContain("Custom domains your pick");
  });

  it("lists the agents it works with: marks in their own colours and the Hermes tile, nothing loaded from outside", () => {
    const sec =
      index.match(
        /<section class="x-sec x-band x-agents"[\s\S]*?<\/section>/,
      )?.[0] ?? "";
    const chips = [...sec.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) =>
      m[1]
        .replace(/<svg[\s\S]*?<\/svg>/g, "")
        .replace(/<[^>]+>/g, "")
        .trim(),
    );
    expect(chips).toEqual([
      "Claude Code",
      "Codex",
      "Cursor",
      "OpenCode",
      "pi",
      "Hermes",
      "OpenClaw",
      "Gemini coming soon",
      "and any AI agent that speaks MCP",
    ]);
    expect(sec).toMatch(/<li class="soon">/);
    const marks = sec.match(/<svg [^>]*>/g) ?? [];
    // six marks, plus Gemini's while GEMINI_MARK is on (name only when off)
    expect(marks).toHaveLength(GEMINI_MARK ? 7 : 6);
    expect(sec).toMatch(
      GEMINI_MARK
        ? /<li class="soon"><svg [^>]*>[\s\S]*<\/svg>Gemini <small>coming soon<\/small><\/li>/
        : /<li class="soon">Gemini <small>coming soon<\/small><\/li>/,
    );
    for (const m of marks) expect(m).toContain('aria-hidden="true"');
    // Hermes is the project's PNG, inline
    const imgs = sec.match(/<img [^>]*>/g) ?? [];
    expect(imgs).toHaveLength(1);
    expect(imgs[0]).toMatch(/src="data:image\/png;base64,/);
    // names are text, not alt text; nothing is fetched
    expect(sec).not.toMatch(/src="https?:|href="https?:|url\((?!#)/);
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
    // "Log in" is the hosted sign-up URL, right before GitHub; with no URL at
    // build time there is no link at all (never an anchor fallback)
    const url = process.env.HOSTED_SIGNUP_URL?.trim();
    if (url) {
      expect(nav).toContain(`<a class="login" href="${url}">Log in</a>`);
      expect(nav.indexOf("Log in")).toBeLessThan(nav.indexOf("GitHub"));
    } else {
      expect(nav).not.toContain("Log in");
    }
  });

  it("the home footer says only Open Artifacts. Open source, MIT licensed.", () => {
    expect(index).toContain(
      "<p>Open Artifacts. Open source, MIT licensed.</p>",
    );
    expect(index).not.toContain("runs on your own Cloudflare account");
  });

  it("the Decide chapter shows the ask card as the product draws it", () => {
    const card =
      index.match(/<div class="card ask need">[\s\S]*?<\/p>/)?.[0] ?? "";
    expect(card).toContain(
      'OA Product <span class="x-tag">agent</span> asks you and Sam Rivera',
    );
    expect(card).toContain("<b>Email list</b>");
    expect(card).toContain("Recommended");
    expect(card).toContain("Ask a question");
    expect(card).toContain("Next ask");
    expect(index).toContain("2 asks for you");
  });

  it("the phone chapter buttons say what to try", () => {
    expect(text).toContain("Try it: turn on the public link");
    expect(text).toContain("Try it: vote, or tick an item");
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
    expect(text.match(/Which feature leads the demo\?/g)).toHaveLength(2);
    const poll = index.match(/<div class="poll asm"[\s\S]*?<\/div>/)?.[0] ?? "";
    expect(
      poll.match(/<button type="button" aria-pressed="false">/g),
    ).toHaveLength(3);
    // Comments 1, Live checklists 3, Versions 0 (4 votes)
    expect(poll).toMatch(
      /Comments<\/span><span class="you">Your vote<\/span><b>1<\/b>/,
    );
    expect(poll).toMatch(
      /Live checklists<\/span><span class="you">Your vote<\/span><b>3<\/b>/,
    );
    expect(poll).toMatch(
      /Versions<\/span><span class="you">Your vote<\/span><b>0<\/b>/,
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

  it("breaks the close headline in three lines, and says it as one sentence", () => {
    const h2 =
      index.match(/<h2 id="close-h" class="x-cl">[\s\S]*?<\/h2>/)?.[0] ?? "";
    expect(h2.match(/<br\s*\/?>/g)).toHaveLength(2);
    expect(text).toContain(
      "Where people and agents come to do their best work, together.",
    );
  });

  it("keeps the three self-host steps and the jump to them", () => {
    expect(index).toMatch(/<section[^>]*id="self-host"/);
    for (const step of [
      "Tell your agent",
      "Log in to Cloudflare",
      "Publish and share",
    ])
      expect(index).toContain(`<h3>${step}</h3>`);
    expect(index).toContain("<code>npx wrangler login</code>");
    expect(index).toMatch(/<a class="btn" href="#self-host">Self-host it<\/a>/);
  });
});
