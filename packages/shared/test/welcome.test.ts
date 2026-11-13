import { describe, expect, it } from "vitest";
import {
  welcomeHtml,
  welcomeSetupPrompt,
  welcomeTabs,
} from "../src/welcome.js";

const HOST = "https://oa.example.com";

describe("welcomeHtml", () => {
  const html = welcomeHtml(HOST);

  it("has Product's copy, verbatim", () => {
    for (const s of [
      "This is your Open Artifacts instance. Your agents publish pages here, and you read them, comment, and answer their questions.",
      "Connect your agent",
      "Paste this into your agent. It connects to this instance and learns how to publish here.",
      "Get started",
      "Publish your first artifact",
      "Leave a comment",
      "Select this sentence and add a comment. Your agent can read it and reply in the thread.",
      "You can delete this page any time. Nothing else depends on it.",
      "You're set. Everything you publish is in the",
      "Agent connected",
      "Commented",
      "Published: ",
      "Copied",
    ])
      expect(html).toContain(s);
    expect(html).toContain(
      "Ask your agent: &quot;Publish a page about what you're working on.&quot;",
    );
    expect(html).toContain(
      "Select the highlighted sentence below and comment on it.",
    );
  });

  it("uses no em dashes", () => {
    expect(html).not.toContain("—");
  });

  it("names the instance's own host in the prompt and the client lines", () => {
    expect(welcomeSetupPrompt(HOST)).toBe(
      `Set up Open Artifacts for me: follow ${HOST}/llms.txt`,
    );
    expect(html).toContain(`follow ${HOST}/llms.txt`);
    expect(html).toContain(`${HOST}/mcp`);
    expect(welcomeHtml(`${HOST}/`)).toContain(`follow ${HOST}/llms.txt`);
  });

  it("has the four tabs, the first selected", () => {
    expect(welcomeTabs(HOST).map((t) => t.label)).toEqual([
      "Any agent",
      "Claude Code",
      "Codex",
      "Cursor",
    ]);
    expect((html.match(/role="tab"/g) ?? []).length).toBe(4);
    expect(html.match(/aria-selected="true"/g) ?? []).toHaveLength(1);
  });

  it("works in both themes at phone width, with one script that cannot be closed early", () => {
    expect(html).toContain("prefers-color-scheme:dark");
    expect(html).toContain('name="viewport"');
    expect(html).toContain("@media (max-width:420px)");
    // The embedded JSON cannot close its own block.
    const hostile = welcomeHtml("https://x.test/</script><b>");
    expect(hostile).not.toContain("</script><b>");
  });

  it("asks the shell, not the network", () => {
    expect(html).toContain("onboarding.get()");
    expect(html).not.toContain("fetch(");
  });
});
