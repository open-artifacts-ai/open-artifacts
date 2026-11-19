// #2649: the outside share email stays readable in light and dark. The colors
// come from the template itself: the inline (light) styles and the
// prefers-color-scheme: dark block. WCAG: text 4.5:1, the button against the
// page 3:1.
import { describe, expect, it } from "vitest";
import { outsideShareEmail } from "../src/email/templates.js";

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return (
    0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number)
  );
};
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return ((x as number) + 0.05) / ((y as number) + 0.05);
};
const full = (h: string) =>
  h.length === 4 ? `#${[...h.slice(1)].map((c) => c + c).join("")}` : h;

const { html } = outsideShareEmail({
  inviter: "Sam Rivera",
  instance: "Acme",
  recipient: "guest@example.org",
  appHost: "oa.example.com",
  signIn: ["email"],
  title: "Q3 launch plan",
  path: "/a/Zk3m9qLw",
  senderEmail: "sam@acme.test",
  optOutUrl: "https://oa.example.com/auth/unsubscribe/shares?t=x",
} as Parameters<typeof outsideShareEmail>[0]);

/** The first `prop:#hex` in the CSS rule for `sel` inside the dark block. */
const dark = (sel: string, prop: string) => {
  const block =
    /@media \(prefers-color-scheme: dark\)\{(.*?)\}\}/s.exec(html)?.[1] ?? "";
  const rule =
    new RegExp(
      `(?:^|\\})\\s*[^{}]*${sel.replace(".", "\\.")}[^{]*\\{([^}]*)`,
    ).exec(block)?.[1] ?? "";
  return full(
    new RegExp(`(?:^|;)${prop}:(#[0-9a-f]{3,6})`, "i").exec(rule)?.[1] ?? "",
  );
};
/** The inline `prop:#hex` on the element with `cls`, or on the body. */
const light = (marker: RegExp, prop: string) => {
  const tag = marker.exec(html)?.[0] ?? "";
  return full(new RegExp(`${prop}:(#[0-9a-f]{3,6})`, "i").exec(tag)?.[1] ?? "");
};

describe("outside share email contrast (#2649)", () => {
  it("dark: button, its text and the footer are readable", () => {
    const page = dark("body", "background");
    const text = dark("body", "color");
    const btn = dark(".oa-btn", "background");
    const btnText = dark(".oa-btn", "color");
    const foot = dark(".oa-foot", "color");
    for (const c of [page, text, btn, btnText, foot])
      expect(c).toMatch(/^#[0-9a-f]{6}$/i);
    expect(ratio(text, page)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(btn, page)).toBeGreaterThanOrEqual(3);
    expect(ratio(btnText, btn)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(foot, page)).toBeGreaterThanOrEqual(4.5);
  });
  it("light: button text and the footer are readable on white", () => {
    const btn = light(/<a class="oa-btn"[^>]*>/, "background");
    const btnText = light(/<a class="oa-btn"[^>]*>/, "color");
    const foot = light(/<p class="oa-foot"[^>]*>/, "color");
    expect(ratio(btnText, btn)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(btn, "#ffffff")).toBeGreaterThanOrEqual(3);
    expect(ratio(foot, "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });
});
