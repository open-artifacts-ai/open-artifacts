import { describe, expect, it } from "vitest";
import { audit } from "../src/audit.js";
import { NotImplemented } from "../src/errors.js";
import type { Principal } from "../src/principal.js";
import { fakeEnv } from "./fakes.js";

const admin: Principal = {
  kind: "admin",
  actorKey: "admin:me@example.com",
  rateKey: "admin:me@example.com",
  label: "me@example.com",
  scopes: [],
  email: "me@example.com",
  sub: "123",
  authAt: 0,
};
describe("C4 service stubs", () => {
  it("audit rejects until W4", async () => {
    const { env } = fakeEnv();
    await expect(
      audit(env, {
        action: "authz.refused",
        actor: admin,
        outcome: "refused",
        route: "R2",
        code: "forbidden",
      }),
    ).rejects.toBeInstanceOf(NotImplemented);
  });
});
