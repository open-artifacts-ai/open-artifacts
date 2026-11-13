// #2287: the Welcome page's own script, run in jsdom against a stand-in runtime.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { welcomePage as welcomeHtml } from "@oa/shared";

const HOST = "https://oa.example.com";

type Progress = {
  agentConnected: boolean;
  firstArtifact: { id: string; title: string } | null;
  commented: boolean;
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
    for (const k of ["connect", "publish", "comment"])
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
    expect(step("comment").dataset.done).toBe("false");
  });

  it("says it is set when all three are done, then stops asking", async () => {
    await load();
    progress = {
      agentConnected: true,
      firstArtifact: { id: "Cd5fGhJkLm6nPqRs", title: "T" },
      commented: true,
    };
    await vi.advanceTimersByTimeAsync(5000);
    expect((document.getElementById("all-done") as HTMLElement).hidden).toBe(
      false,
    );
    expect(step("comment").textContent).toContain("Commented");
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
      "Leave a comment",
      "Select this sentence and add a comment. Your agent can read it and reply in the thread.",
      "You can delete this page any time. Nothing else depends on it.",
      "You're set. Everything you publish is in the",
      "Agent connected",
      "Commented",
      "Select the highlighted sentence below and comment on it.",
      "Ask your agent: &quot;Publish a page about what you're working on.&quot;",
    ])
      expect(html).toContain(t);
    expect(raw).not.toContain("\u2014");
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
