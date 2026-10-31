import { API_ERROR_STATUS } from "@oa/shared/provisioning";
import { describe, expect, it } from "vitest";
import { refuse } from "../src/refuse.js";
import { API, fakeEnv } from "./fakes.js";

describe("refuse (4.9)", () => {
  it("answers the envelope with the code's one status, no-store", async () => {
    const { env } = fakeEnv();
    for (const code of [
      "unauthenticated",
      "rate_limited",
      "unavailable",
    ] as const) {
      const res = await refuse(env, "pre", code, new Request(`${API}/v1/me`));
      expect(res.status).toBe(API_ERROR_STATUS[code]);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe(code);
    }
  });
});
