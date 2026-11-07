import { afterEach, describe, expect, it, vi } from "vitest";
import { safeContentUrl } from "../src/viewer/frame";
import { createOpener } from "../src/viewer/navigate";

afterEach(() => vi.unstubAllGlobals());
describe("single-host content", () => {
  it("accepts versioned same-host content, never application pages", () => {
    vi.stubGlobal("location", { origin: "https://app.test" });
    for (const path of ["/c/token/abc/v1/__view", "/p/abc/v2/index.html"])
      expect(safeContentUrl(`https://app.test${path}`)).toBe(
        `https://app.test${path}`,
      );
    for (const path of [
      "/auth/login",
      "/api/v1/me",
      "/a/abc",
      "/c/token/abc/v0/__view",
      "/c/token/abc/v1/../../auth/login",
    ])
      expect(safeContentUrl(`https://app.test${path}`)).toBeNull();
  });
});

it("allows viewer navigation while blocking content and auth links sharing that hostname", () => {
  const go = vi.fn();
  const refuse = vi.fn();
  const assign = vi.fn();
  const open = createOpener({
    go,
    refuse,
    assign,
    ask: vi.fn(),
    limit: () => true,
    origin: "https://app.test",
    contentOrigin: () => "https://app.test",
    active: () => true,
  });
  open("https://app.test/a/other");
  expect(go).toHaveBeenCalledWith("/a/other");
  open("https://app.test/c/token/id/v1/__view");
  expect(refuse).toHaveBeenCalledTimes(1);
  expect(assign).not.toHaveBeenCalled();
});
