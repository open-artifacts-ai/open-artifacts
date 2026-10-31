import { expect, it } from "vitest";
import { safeReturn } from "../src/auth/safeReturn";

it.each([
  ["/installs", "/installs"],
  ["/installs/abc?x=1#top", "/installs/abc?x=1#top"],
  ["/jobs/j1", "/jobs/j1"],
  ["/", "/"],
  // Percent-encoded text stays literal path text in a browser.
  ["/%2f/evil.example", "/%2f/evil.example"],
  ["/%5cevil.example", "/%5cevil.example"],
  // Fallbacks.
  ["//x", "/installs"],
  ["/\\x", "/installs"],
  ["//evil.example", "/installs"],
  ["/\\evil.example", "/installs"],
  ["https://evil.example", "/installs"],
  ["javascript:alert(1)", "/installs"],
  ["installs", "/installs"],
  ["", "/installs"],
  [undefined, "/installs"],
  [42, "/installs"],
  [" /installs", "/installs"],
  ["\\\\evil.example", "/installs"],
  // /auth/ is never a return target.
  ["/auth/x", "/installs"],
  ["/auth/start?return=/", "/installs"],
  // Control, whitespace and non-ASCII characters.
  ["/\t/evil.example", "/installs"],
  ["/\n/evil.example", "/installs"],
  ["/x y", "/installs"],
  ["/x\u0000y", "/installs"],
  ["/\u007f", "/installs"],
  ["/café", "/installs"],
  ["/\u202eevil", "/installs"],
])("safeReturn(%j) is %j", (raw, out) => {
  expect(safeReturn(raw)).toBe(out);
});
