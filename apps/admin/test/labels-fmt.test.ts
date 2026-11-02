import { expect, it } from "vitest";
import { fmtIn } from "../src/components/labels";

it("fmtIn never shows 60 s: seconds up to 59 s, then minutes", () => {
  expect(fmtIn(0)).toBe("now");
  expect(fmtIn(1)).toBe("1 s");
  expect(fmtIn(59_000)).toBe("59 s");
  expect(fmtIn(59_001)).toBe("1 min");
  expect(fmtIn(59_499)).toBe("1 min");
  expect(fmtIn(90_000)).toBe("2 min");
});
