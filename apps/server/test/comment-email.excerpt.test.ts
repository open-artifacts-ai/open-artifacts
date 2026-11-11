import { describe, expect, it } from "vitest";
import { excerptOf } from "../src/email/comment-email.js";

// #1997: an excerpt leaves no link a mail client would make clickable.
describe("excerptOf defangs every bare host", () => {
  it.each([
    ["see пример.рф now", "see пример[.]рф now"],
    ["go to bücher.de/x", "go to bücher[.]de/x"],
    ["xn--e1afmkfd.xn--p1ai", "xn--e1afmkfd[.]xn--p1ai"],
    ["例え.テスト", "例え[.]テスト"],
    ["host 192.168.0.1 here", "host 192[.]168[.]0[.]1 here"],
    ["10.0.0.1:8080/admin", "10[.]0[.]0[.]1:8080/admin"],
    ["at 8.8.8.8.", "at 8[.]8[.]8[.]8."],
    ["http://203.0.113.5/x", "http[:]//203[.]0[.]113[.]5/x"],
  ])("%s", (raw, want) => {
    expect(excerptOf(raw)).toBe(want);
  });

  it.each([
    "e.g. this",
    "version 1.5 shipped",
    "1.2.3",
    "pi is 3.14159",
    "@alice said hi",
  ])("leaves %s alone", (raw) => {
    expect(excerptOf(raw)).toBe(raw);
  });
});
