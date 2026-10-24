import { describe, expect, it } from "vitest";
import { heroActions, SELF_HOST_HREF } from "../src/lib/hero";

// #421: hosted sign-up leads once its URL is set; until then, self-host does.
describe("heroActions", () => {
  it.each([undefined, "", "   "])(
    "with no sign-up URL (%j), self-host is the only, primary, action",
    (url) => {
      expect(heroActions(url)).toEqual([
        { label: "Self-host it", href: SELF_HOST_HREF, primary: true },
      ]);
    },
  );

  it("with a sign-up URL, Get started free leads and self-host is second", () => {
    expect(heroActions(" https://app.example.com/sign-up ")).toEqual([
      {
        label: "Get started free",
        href: "https://app.example.com/sign-up",
        primary: true,
      },
      { label: "Self-host it", href: SELF_HOST_HREF, primary: false },
    ]);
  });
});
