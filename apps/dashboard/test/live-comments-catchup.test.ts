// cloud #291: a reply made after the viewer fetched the comments list but
// before its events socket joined sends its `comments` frame to no one. Every
// hello refetches the list, so that reply still shows without a reload.
import { expect, it } from "vitest";
import { refetchesComments } from "../src/viewer/useLiveVersions";

it("a comments frame and every hello refetch the comments list", () => {
  expect(refetchesComments({ type: "comments" })).toBe(true);
  expect(refetchesComments({ type: "hello" })).toBe(true);
});

it("version, presence and gone frames leave the comments list alone", () => {
  for (const type of ["version", "presence", "gone"])
    expect(refetchesComments({ type })).toBe(false);
});
