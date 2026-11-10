import { describe, expect, it } from "vitest";
import { maskBody } from "../src/services/comments.js";

// #1890: guests never see a mentioned agent's bus name, whatever the case.
const pairs: [string, string][] = [["OA Product", "Leo's agent"]];
const mask = (b: string) => maskBody(b, pairs);

describe("maskBody (#1890)", () => {
  it.each(["@OA Product", "@oa product", "@OA PRODUCT", "@Oa pRoDuCt"])(
    "%s is masked",
    (m) => {
      expect(mask(`hi ${m}, please look`)).toBe("hi @Leo's agent, please look");
      expect(mask(`${m}`)).toBe("@Leo's agent");
      expect(mask(`(${m}.)`)).toBe("(@Leo's agent.)");
    },
  );
  it("masks every occurrence in one pass", () => {
    expect(mask("@oa product and @OA Product")).toBe(
      "@Leo's agent and @Leo's agent",
    );
  });
  it("leaves non-mention text, emails and URLs alone", () => {
    for (const b of [
      "OA Product shipped",
      "mail me@oa product.com",
      "mail a@OA.com",
      "see https://x.com/@oa product",
      "x@oa product",
    ])
      expect(mask(b)).toBe(b);
  });
  it("an unchanged name is left alone, longest name wins", () => {
    expect(maskBody("@A b", [["A b", "A b"]])).toBe("@A b");
    expect(
      maskBody("@Runner2 and @Runner", [
        ["Runner", "X"],
        ["Runner2", "Y"],
      ]),
    ).toBe("@Y and @X");
  });
});
