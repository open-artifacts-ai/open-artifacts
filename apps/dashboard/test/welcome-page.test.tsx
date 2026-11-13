// #2287: the Welcome page's own script, run in jsdom against a stand-in runtime.
import { welcomeHtml } from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
