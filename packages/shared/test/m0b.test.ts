import { describe, expect, expectTypeOf, it } from "vitest";
import * as S from "../src/index.js";
import { newId } from "../src/index.js";

describe("M0 follow-up", () => {
  it("per-method types survive", () => {
    expectTypeOf<S.RuntimeParams<"db.get">>().toEqualTypeOf<{
      collection: string;
      id: string;
    }>();
    expectTypeOf<S.RuntimeResult<"db.get">>().toEqualTypeOf<S.DataDoc | null>();
    expectTypeOf<S.RuntimeResult<"storage.list">>().toEqualTypeOf<
      S.Page<S.StorageKey>
    >();
  });
  it("storage.list matches REST", () => {
    expect(
      S.RUNTIME_PARAMS["storage.list"].safeParse({ cursor: "c", limit: 5 })
        .success,
    ).toBe(true);
    expect(S.RUNTIME_PARAMS["storage.list"].safeParse({}).success).toBe(true);
    expect(S.RUNTIME_PARAMS["storage.list"].safeParse({ x: 1 }).success).toBe(
      false,
    );
    const page = { items: [{ key: "k", updatedAt: "t" }], nextCursor: null };
    expect(S.RUNTIME_RESULTS["storage.list"].safeParse(page).success).toBe(
      true,
    );
    expect(S.RUNTIME_RESULTS["storage.list"].safeParse(["a"]).success).toBe(
      false,
    );
  });
  it("upload artifactId is an id", () => {
    const ok = { path: "a", size: 1 };
    expect(
      S.UploadCreateInputSchema.safeParse({ ...ok, artifactId: newId() })
        .success,
    ).toBe(true);
    expect(
      S.UploadCreateInputSchema.safeParse({ ...ok, artifactId: "bad" }).success,
    ).toBe(false);
    expect(S.UploadCreateInputSchema.safeParse(ok).success).toBe(true);
  });
  it("input-side types", () => {
    expectTypeOf<S.ListQueryInput["limit"]>().toEqualTypeOf<unknown>();
    expectTypeOf<S.DataQueryInput["limit"]>().toEqualTypeOf<
      number | undefined
    >();
    expectTypeOf<S.GetArtifactInputInput["includeContent"]>().toEqualTypeOf<
      boolean | undefined
    >();
    expectTypeOf<S.SearchQueryInput["q"]>().toEqualTypeOf<string>();
  });
});

it("accepts an optional client SHA-256 and rejects malformed checksums", () => {
  const input = { path: "report.pdf", size: 3 };
  expect(
    S.UploadCreateInputSchema.parse({ ...input, sha256: "AB".repeat(32) })
      .sha256,
  ).toBe("ab".repeat(32));
  for (const sha256 of ["", "a".repeat(63), "a".repeat(65), "g".repeat(64)])
    expect(
      S.UploadCreateInputSchema.safeParse({ ...input, sha256 }).success,
    ).toBe(false);
  expect(S.UploadCreateInputSchema.safeParse(input).success).toBe(true);
});
