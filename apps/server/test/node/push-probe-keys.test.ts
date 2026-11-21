// The two push reads answer 200 on an install with VAPID keys (cloud mints
// them, cloud #390) and 404 push_unavailable without. A 200 counts as
// allowed only where the caller is expected allowed: every foreign caller is
// still expected refused, so a 200 on a cross-install leg fails the case.
import { describe, expect, it } from "vitest";
import { FOREIGN_CALLERS, orgExpected } from "../authz/expect.ts";
import { ORG_SURFACES } from "../authz/surfaces.ts";

const BASE = "https://b.example.invalid";
const answer = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), { status });
const ROUTES = [
  "GET /api/v1/me/push/key",
  "GET /api/v1/me/push/subscriptions",
] as const;

describe.each(ROUTES)("%s on an install with push keys", (route) => {
  const s = ORG_SURFACES.find((x) => x.route === route);
  if (!s) throw new Error(`${route} is not in ORG_SURFACES`);
  const probe = (status: number, body: unknown) =>
    s.probe(
      BASE,
      { token: "t" },
      {} as never,
      {
        fetch: answer(status, body),
      } as never,
    );

  it("a 200 reads as allowed, as does 404 push_unavailable", async () => {
    expect(await probe(200, { publicKey: "k" })).toBe("allow");
    expect(
      await probe(404, { error: { code: "push_unavailable", message: "" } }),
    ).toBe("allow");
  });

  it("every foreign caller is expected refused, so its 200 fails the leg", async () => {
    const verdict = await probe(200, []);
    for (const who of FOREIGN_CALLERS) {
      const want = orgExpected(who, s.rule as never, route);
      expect(want).toBe("deny");
      expect(verdict).not.toBe(want);
    }
  });

  it("a foreign caller's 401 is refused", async () => {
    expect(
      await probe(401, { error: { code: "unauthorized", message: "" } }),
    ).toBe("deny");
  });
});
