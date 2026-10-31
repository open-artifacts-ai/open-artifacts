import { describe, expect, it } from "vitest";
import { authenticate } from "../src/auth/authenticate.js";
import { isRefusal } from "../src/principal.js";
import { platformDb } from "./db.js";
import { ADMIN, API, fakeEnv } from "./fakes.js";

// The admin session path is W5a (test/session.test.ts); the api bearers are
// W5b and still fail closed.
describe("authenticate", () => {
  it("fails closed for every api credential and an unknown admin cookie", async () => {
    await platformDb();
    const { env } = fakeEnv();
    const reqs: [Request, "admin" | "api"][] = [
      [new Request(`${API}/v1/me`), "api"],
      [
        new Request(`${API}/v1/me`, {
          headers: { authorization: `Bearer oat_${"a".repeat(43)}` },
        }),
        "api",
      ],
      [
        new Request(`${API}/mcp`, {
          method: "POST",
          headers: { authorization: "Bearer u:g:s" },
        }),
        "api",
      ],
      [
        new Request(`${ADMIN}/api/v1/me`, {
          headers: { cookie: "__Host-oa-admin=x" },
        }),
        "admin",
      ],
    ];
    for (const [req, host] of reqs) {
      const r = await authenticate(req, env, host);
      expect(isRefusal(r)).toBe(true);
      expect(r).toEqual({ refusal: true, code: "unauthenticated" });
    }
  });
});
