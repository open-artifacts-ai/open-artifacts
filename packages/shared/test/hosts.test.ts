import { describe, expect, it } from "vitest";
import { normalizeHost } from "../src/hosts.js";

describe("normalizeHost", () => {
  it("trims, lowercases, drops a port and one trailing dot", () => {
    for (const h of [
      "app.example.com",
      "APP.Example.COM",
      " app.example.com\n",
      "app.example.com.",
      "app.example.com:443",
      "app.example.com.:8787",
      "App.Example.com.:443 ",
    ])
      expect(normalizeHost(h)).toBe("app.example.com");
  });

  it("strips one trailing dot only, and keeps an empty value empty", () => {
    expect(normalizeHost("a.example.com..")).toBe("a.example.com.");
    expect(normalizeHost("")).toBe("");
    expect(normalizeHost("   ")).toBe("");
  });
});
