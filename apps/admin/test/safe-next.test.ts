import { expect, it } from "vitest";
import { safeNext } from "../src/auth/safeNext";

it.each([
  ["/mine", "/mine"],
  ["/a/De6gHjKmNp7qRsTu?v=2#top", "/a/De6gHjKmNp7qRsTu?v=2#top"],
  ["//evil.example", "/"],
  ["//evil.example/path", "/"],
  ["/\\evil.example", "/"],
  ["https://evil.example", "/"],
  ["javascript:alert(1)", "/"],
  ["/x\u0000y", "/"],
  ["/x y", "/"],
  ["mine", "/"],
  ["", "/"],
  [undefined, "/"],
  [42, "/"],
  // Browsers strip tabs and newlines from URLs, so "/\t/evil" would become "//evil".
  ["/\t/evil.example", "/"],
  ["/\n/evil.example", "/"],
  ["/\u007f", "/"],
  ["/ /evil.example", "/"],
  ["\\\\evil.example", "/"],
  [" /mine", "/"],
])("safeNext(%j) is %j", (raw, out) => {
  expect(safeNext(raw)).toBe(out);
});
