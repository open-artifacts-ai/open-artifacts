import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MentionedText } from "../src/viewer/comments/asks";
import { linkify } from "../src/viewer/comments/linkify";

const urls = (s: string) =>
  linkify(s)
    .filter((p) => p.url)
    .map((p) => p.text);

describe("linkify", () => {
  it("returns plain text as one piece", () => {
    expect(linkify("hello there")).toEqual([{ text: "hello there" }]);
    expect(linkify("")).toEqual([]);
  });
  it("links a plain URL and keeps the text around it", () => {
    expect(linkify("see https://a.com/x now")).toEqual([
      { text: "see " },
      { text: "https://a.com/x", url: true },
      { text: " now" },
    ]);
  });
  it("drops trailing punctuation", () => {
    expect(urls("go to https://a.com.")).toEqual(["https://a.com"]);
    expect(urls("https://a.com, then")).toEqual(["https://a.com"]);
    expect(urls("(see https://a.com/x)")).toEqual(["https://a.com/x"]);
    expect(urls("https://a.com/x?!")).toEqual(["https://a.com/x"]);
    expect(urls('"https://a.com/x";')).toEqual(["https://a.com/x"]);
    expect(urls("'https://a.com/x'")).toEqual(["https://a.com/x"]);
    expect(urls("https://a.com/x:")).toEqual(["https://a.com/x"]);
    expect(urls("[https://a.com/x]")).toEqual(["https://a.com/x"]);
  });
  it("keeps balanced parens", () => {
    expect(urls("https://en.wikipedia.org/wiki/Foo_(bar)")).toEqual([
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    ]);
    expect(urls("(https://en.wikipedia.org/wiki/Foo_(bar))")).toEqual([
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    ]);
    expect(urls("https://en.wikipedia.org/wiki/Foo_(bar).")).toEqual([
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    ]);
  });
  it("keeps query and fragment", () => {
    expect(urls("https://a.com/p?q=1&r=2#frag.")).toEqual([
      "https://a.com/p?q=1&r=2#frag",
    ]);
  });
  it("links two URLs", () => {
    expect(urls("http://a.com and https://b.com/x")).toEqual([
      "http://a.com",
      "https://b.com/x",
    ]);
  });
  it("accepts uppercase schemes", () => {
    expect(urls("HTTPS://A.COM/x")).toEqual(["HTTPS://A.COM/x"]);
  });
  it("stops at angle brackets", () => {
    expect(urls("<https://a.com/x>")).toEqual(["https://a.com/x"]);
  });
  it("does not link other schemes or bare domains", () => {
    expect(urls("javascript:alert(1)")).toEqual([]);
    expect(urls("data:text/html,hi")).toEqual([]);
    expect(urls("mailto:a@b.com")).toEqual([]);
    expect(urls("example.com and www.example.com")).toEqual([]);
    expect(urls("https://")).toEqual([]);
  });
});

describe("MentionedText links", () => {
  it("renders a safe anchor", () => {
    render(<MentionedText body="see https://a.com/x." />);
    const a = screen.getByRole("link", { name: "https://a.com/x" });
    expect(a.getAttribute("href")).toBe("https://a.com/x");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
  });
  it("keeps mention chips and links side by side", () => {
    const { container } = render(
      <MentionedText
        body="@bot https://a.com/x"
        mentions={[{ key: "k", name: "bot" }]}
      />,
    );
    expect(container.querySelector("[data-mention-chip]")?.textContent).toBe(
      "@bot",
    );
    expect(screen.getByRole("link").getAttribute("href")).toBe(
      "https://a.com/x",
    );
  });
  it("never links inside a mention", () => {
    const { container } = render(
      <MentionedText
        body="@http://x.com hi"
        mentions={[{ key: "k", name: "http://x.com" }]}
      />,
    );
    expect(container.querySelector("a")).toBeNull();
  });
});
