import { describe, expect, it, vi } from "vitest";

vi.mock("node:os", async (orig) => ({
  ...(await orig<typeof import("node:os")>()),
  userInfo: () => {
    throw new Error("ERR_SYSTEM_ERROR: no passwd entry");
  },
}));

describe("a uid with no passwd entry", () => {
  it("builds the context and skips the isolation check", async () => {
    const { realCtx } = await import("../src/context.ts");
    const ctx = realCtx(false);
    expect(ctx.service.isolated).toBeUndefined();
  });
});
