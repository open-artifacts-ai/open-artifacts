// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

let active = 0;
let maxActive = 0;
const runs: string[] = [];
vi.mock("mermaid", () => ({
  default: {
    initialize: (c: { themeVariables: { background: string } }) =>
      runs.push(c.themeVariables.background),
    run: async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      // Yield a turn, so an unserialized second run would start meanwhile.
      await new Promise((r) => setImmediate(r));
      active--;
    },
  },
}));

import { prepareMarkdown, renderMarkdown } from "../src/markdown";
import { renderMermaid } from "../src/mermaid";
import {
  applyTheme,
  currentTheme,
  followSystemTheme,
  onThemeChange,
  resetThemeForTests,
} from "../src/theme";

describe("markdown highlight budget", () => {
  it("renders a fence over 64 KB as escaped plain <pre>", async () => {
    const body = "const a = '<b>';\n".repeat(4_000); // ~68 KB
    const md = `\`\`\`ts\n${body}\`\`\`\n`;
    await prepareMarkdown(md);
    const out = renderMarkdown(md);
    expect(out).not.toContain('class="shiki');
    expect(out).toContain("&lt;b&gt;");
  });

  // Unknown-language fences take the cheap unhighlighted path but still count
  // against the budget: this proves the fallback without stressing shiki.
  it("stops highlighting once a document passes 256 KB of fences", async () => {
    const fence = `\`\`\`text\n${"x".repeat(60 * 1024)}\n\`\`\`\n\n`; // 60 KB
    const md = fence.repeat(6); // 4 × 60 KB fit; the 5th crosses 256 KB
    const shiki = renderMarkdown(md).match(/class="shiki/g) ?? [];
    expect(shiki.length).toBe(4);
  });
});

describe("mermaid re-runs", () => {
  it("serializes runs on rapid theme flips", async () => {
    document.body.innerHTML = '<pre class="mermaid">graph TD; A-->B</pre>';
    await Promise.all([
      renderMermaid(document.body, "dark"),
      renderMermaid(document.body, "light"),
      renderMermaid(document.body, "dark"),
    ]);
    expect(maxActive).toBe(1);
    expect(runs).toEqual(["#1c1f23", "#ffffff", "#1c1f23"]);
  });
});

describe("system theme", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-theme");
    resetThemeForTests();
    vi.unstubAllGlobals();
  });

  function stubMedia(dark: boolean) {
    const mq = {
      matches: dark,
      listeners: [] as (() => void)[],
      addEventListener(_: string, fn: () => void) {
        this.listeners.push(fn);
      },
      removeEventListener() {},
    };
    vi.stubGlobal("matchMedia", () => mq);
    return {
      flip(d: boolean) {
        mq.matches = d;
        for (const fn of mq.listeners) fn();
      },
    };
  }

  it("follows prefers-color-scheme without pinning data-theme", () => {
    const media = stubMedia(false);
    const seen: string[] = [];
    onThemeChange((t) => seen.push(t));
    followSystemTheme();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    media.flip(true);
    expect(currentTheme()).toBe("dark");
    expect(seen).toEqual(["dark"]);
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("ignores the OS once the shell sets a theme", () => {
    const media = stubMedia(false);
    const seen: string[] = [];
    onThemeChange((t) => seen.push(t));
    followSystemTheme();
    applyTheme("light");
    media.flip(true);
    expect(currentTheme()).toBe("light");
    expect(seen).toEqual([]);
  });
});
