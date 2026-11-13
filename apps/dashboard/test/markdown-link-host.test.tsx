import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Markdown, MarkdownInline } from "../src/viewer/comments/Markdown";
import { hostAfterLabel } from "../src/viewer/comments/mdparse";

const coarse = (on: boolean) =>
  vi.stubGlobal(
    "matchMedia",
    (q: string) =>
      ({
        matches: on && q === "(pointer: coarse)",
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
afterEach(() => vi.unstubAllGlobals());

describe("hostAfterLabel (#2348)", () => {
  it("gives the host for a label that does not name it", () => {
    expect(hostAfterLabel("https://example.com/a?b=1", "the guide")).toBe(
      "example.com",
    );
    expect(hostAfterLabel("https://www.Example.com/", "the guide")).toBe(
      "example.com",
    );
  });
  it("is null for a bare URL or a label that has the host", () => {
    expect(
      hostAfterLabel("https://example.com/a", "https://example.com/a"),
    ).toBe(null);
    expect(hostAfterLabel("https://example.com/a", "Example.com docs")).toBe(
      null,
    );
    expect(hostAfterLabel("https://www.example.com/", "see example.com")).toBe(
      null,
    );
  });
  it("is null for an unparseable href", () => {
    expect(hostAfterLabel("nope", "x")).toBe(null);
  });
});

describe("link host on touch (#2348)", () => {
  it("shows the host after the label with a coarse pointer", () => {
    coarse(true);
    const { container } = render(
      <Markdown body="read [the guide](https://example.com/x) now" />,
    );
    expect(container.textContent).toBe("read the guide (example.com) now");
    expect(container.querySelector("a")?.textContent).toBe("the guide");
  });
  it("shows nothing with a fine pointer", () => {
    coarse(false);
    const { container } = render(
      <Markdown body="read [the guide](https://example.com/x) now" />,
    );
    expect(container.textContent).toBe("read the guide now");
  });
  it("leaves bare URLs and host-bearing labels alone on touch", () => {
    coarse(true);
    const bare = render(<Markdown body="see https://example.com/x" />);
    expect(bare.container.textContent).toBe("see https://example.com/x");
    // A label that looks like an address is shown as the URL itself: no host.
    const named = render(
      <Markdown body="[example.com docs](https://example.com/x)" />,
    );
    expect(named.container.textContent).toBe("https://example.com/x");
  });
  it("adds nothing when links render as plain text", () => {
    coarse(true);
    const { container } = render(
      <MarkdownInline
        body="[the guide](https://example.com/x)"
        links={false}
      />,
    );
    expect(container.textContent).toBe("the guide");
  });
});
