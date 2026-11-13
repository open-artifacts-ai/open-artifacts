// #2287: the Welcome page's own script, run in jsdom against a stand-in runtime.

import { welcomePage as welcomeHtml } from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const HOST = "https://oa.example.com";

type Progress = {
  agentConnected: boolean;
  firstArtifact: { id: string; title: string } | null;
  commented: boolean;
  agentNamed?: boolean;
  agentName?: string | null;
  mentionReplied?: boolean;
  mentionStalled?: boolean;
  askAnswered?: boolean;
};
let progress: Progress;
let get: ReturnType<typeof vi.fn>;

const load = async () => {
  const html = welcomeHtml(HOST);
  document.documentElement.innerHTML = html
    .replace(/<script>[\s\S]*<\/script>/, "")
    .replace(/^[\s\S]*?<html[^>]*>/, "")
    .replace(/<\/html>[\s\S]*$/, "");
  const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1] ?? "";
  (window as unknown as { openArtifacts: unknown }).openArtifacts = {
    ready: Promise.resolve(),
    theme: "dark",
    onTheme: vi.fn(),
    onboarding: { get },
  };
  new Function(script)();
  await vi.advanceTimersByTimeAsync(0);
};
const step = (k: string) =>
  document.querySelector(`[data-step="${k}"]`) as HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  progress = { agentConnected: false, firstArtifact: null, commented: false };
  get = vi.fn(async () => progress);
});
afterEach(() => {
  vi.useRealTimers();
  document.documentElement.innerHTML = "";
});

describe("Welcome page", () => {
  it("starts with nothing ticked and takes the viewer's theme", async () => {
    await load();
    expect(get).toHaveBeenCalledTimes(1);
    for (const k of ["connect", "name", "publish", "mention", "ask"])
      expect(step(k).dataset.done).toBe("false");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect((document.getElementById("all-done") as HTMLElement).hidden).toBe(
      true,
    );
  });

  it("ticks without a reload, and links the published artifact", async () => {
    await load();
    progress = {
      agentConnected: true,
      firstArtifact: { id: "Cd5fGhJkLm6nPqRs", title: "Q4 <b>report</b>" },
      commented: false,
    };
    await vi.advanceTimersByTimeAsync(5000);
    expect(step("connect").dataset.done).toBe("true");
    expect(step("connect").textContent).toContain("Agent connected");
    expect(step("publish").dataset.done).toBe("true");
    const a = step("publish").querySelector("a") as HTMLAnchorElement;
    expect(a.href).toBe(`${HOST}/a/Cd5fGhJkLm6nPqRs`);
    expect(a.target).toBe("_blank");
    expect(a.rel).toBe("noopener");
    // The title is text, never markup.
    expect(a.textContent).toBe("Q4 <b>report</b>");
    expect(step("publish").querySelector("b b")).toBeNull();
    expect(step("name").dataset.done).toBe("false");
    expect(step("mention").dataset.done).toBe("false");
    expect(step("ask").dataset.done).toBe("false");
    expect(document.getElementById("all-done")?.hidden).toBe(true);
  });

  const five: Progress = {
    agentConnected: true,
    firstArtifact: { id: "Cd5fGhJkLm6nPqRs", title: "T" },
    commented: false,
    agentNamed: true,
    agentName: "Atlas",
    mentionReplied: true,
    askAnswered: true,
  };

  it("ticks the three new steps one by one, with the agent's name", async () => {
    await load();
    // Before a name exists, {name} reads "your agent".
    expect(step("mention").textContent).toContain(
      "type @ in a comment and pick your agent. It replies in the thread.",
    );
    expect(step("ask").textContent).toContain(
      "Your first page has a question from your agent. Pick an option.",
    );
    progress = { ...five, mentionReplied: false, askAnswered: false };
    await vi.advanceTimersByTimeAsync(5000);
    expect(step("name").dataset.done).toBe("true");
    expect(step("name").textContent).toBe("Named: Atlas");
    expect(step("mention").textContent).toContain("pick Atlas.");
    expect(step("ask").textContent).toContain("question from Atlas.");
    progress = { ...five, askAnswered: false };
    await vi.advanceTimersByTimeAsync(5000);
    expect(step("mention").dataset.done).toBe("true");
    expect(step("mention").textContent).toBe("Atlas replied");
    expect(step("ask").dataset.done).toBe("false");
    expect(document.getElementById("all-done")?.hidden).toBe(true);
  });

  it("shows the stalled line only while the mention has no reply", async () => {
    const stalled = () => document.getElementById("stalled") as HTMLElement;
    await load();
    expect(stalled().hidden).toBe(true);
    progress = { ...five, mentionReplied: false, mentionStalled: true };
    await vi.advanceTimersByTimeAsync(5000);
    expect(stalled().hidden).toBe(false);
    expect(stalled().textContent).toBe(
      'No reply yet. Your agent may not be listening. Ask it: "Check the bus."',
    );
    progress = { ...five, mentionStalled: true };
    await vi.advanceTimersByTimeAsync(5000);
    expect(stalled().hidden).toBe(true);
  });

  it("says it is set when all five are done, then stops asking", async () => {
    await load();
    progress = five;
    await vi.advanceTimersByTimeAsync(5000);
    const line = document.getElementById("all-done") as HTMLElement;
    expect(line.hidden).toBe(false);
    expect(line.textContent).toBe(
      "You're set. Your agent hears your comments and answers them.",
    );
    expect(step("ask").textContent).toBe("Answered");
    const n = get.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20000);
    expect(get).toHaveBeenCalledTimes(n);
  });

  it("keeps asking after a refusal and does not pile up requests", async () => {
    get.mockRejectedValueOnce(new Error("forbidden"));
    await load();
    expect(step("connect").dataset.done).toBe("false");
    await vi.advanceTimersByTimeAsync(5000);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("stops asking once the shell refuses it", async () => {
    get.mockRejectedValue(
      Object.assign(new Error("no"), { code: "forbidden" }),
    );
    await load();
    await vi.advanceTimersByTimeAsync(120000);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("asks every 5 s for the first minute, then every 15 s", async () => {
    await load();
    await vi.advanceTimersByTimeAsync(60000);
    const first = get.mock.calls.length;
    expect(first).toBeGreaterThanOrEqual(11);
    await vi.advanceTimersByTimeAsync(60000);
    const next = get.mock.calls.length - first;
    expect(next).toBeGreaterThanOrEqual(3);
    expect(next).toBeLessThanOrEqual(5);
  });

  it("does not ask while the tab is hidden", async () => {
    await load();
    const vis = vi.spyOn(document, "visibilityState", "get");
    vis.mockReturnValue("hidden");
    await vi.advanceTimersByTimeAsync(15000);
    expect(get).toHaveBeenCalledTimes(1);
    vis.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("Copy copies the shown text and says Copied", async () => {
    const writeText = vi.fn(async (_t: string) => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    await load();
    const copy = document.getElementById("copy") as HTMLButtonElement;
    copy.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText).toHaveBeenCalledWith(
      `Set up Open Artifacts for me: follow ${HOST}/llms.txt`,
    );
    expect(copy.textContent).toBe("Copied");
    await vi.advanceTimersByTimeAsync(2000);
    expect(copy.textContent).toBe("Copy");
  });

  it("tabs switch the panel and Copy follows it", async () => {
    const writeText = vi.fn(async (_t: string) => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    await load();
    (document.getElementById("tab-claude") as HTMLElement).click();
    expect((document.getElementById("panel-any") as HTMLElement).hidden).toBe(
      true,
    );
    expect(
      (document.getElementById("panel-claude") as HTMLElement).hidden,
    ).toBe(false);
    (document.getElementById("copy") as HTMLElement).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText.mock.calls[0]?.[0]).toContain("claude mcp add");
    expect(writeText.mock.calls[0]?.[0]).toContain(`${HOST}/mcp`);
  });
});

describe("welcome.html", () => {
  const raw = welcomeHtml("{{x}}");
  const html = welcomeHtml(HOST);

  it("has Product's copy, verbatim, and no em dashes", () => {
    for (const t of [
      "This is your Open Artifacts instance. Your agents publish pages here, and you read them, comment, and answer their questions.",
      "Paste this into your agent. It connects to this instance and learns how to publish here.",
      "Get started",
      "Publish your first artifact",
      "Name your agent",
      "Your agent will suggest a name. It's what you'll type after @ in comments.",
      "Mention your agent",
      "Open your first page, type @ in a comment and pick your agent. It replies in the thread.",
      "Answer your agent's ask",
      "Your first page has a question from your agent. Pick an option.",
      "No reply yet. Your agent may not be listening. Ask it: &quot;Check the bus.&quot;",
      "You can delete this page any time. Nothing else depends on it.",
      "You're set. Your agent hears your comments and answers them.",
      "Agent connected",
      "Ask your agent: &quot;Publish a page about what you're working on.&quot;",
    ])
      expect(html).toContain(t);
    expect(raw).not.toContain("\u2014");
    expect(html).not.toContain("Leave a comment");
    expect(html).not.toContain("Select this sentence");
  });

  it("bakes in the origin it is given", () => {
    expect(html).toContain(`follow ${HOST}/llms.txt`);
    expect(html).toContain(`${HOST}/mcp`);
    expect(welcomeHtml(`${HOST}/`)).toContain(`follow ${HOST}/llms.txt`);
    expect(welcomeHtml('https://x"><script>')).not.toContain("<script>alert");
    expect(raw).not.toContain("fetch(");
  });

  it("has four tabs (the first selected), both themes and a phone width", () => {
    expect(html.match(/role="tab"/g)).toHaveLength(4);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toContain("prefers-color-scheme:dark");
    expect(html).toContain("@media (max-width:420px)");
  });
});
