import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEntry } from "../src/audit.js";
import { hmac16 } from "../src/auth/crypto.js";
import { ApiError } from "../src/errors.js";
import type { Principal } from "../src/principal.js";
import { invokeRoute, type Surface } from "../src/routes/invoke.js";
import { platformDb } from "./db.js";
import { ctx, fakeEnv } from "./fakes.js";

// audit() is W4's (a C4 stub until then); this file checks what invokeRoute
// hands it.
const audited = vi.hoisted(() => [] as unknown[]);
vi.mock("../src/audit.js", () => ({
  audit: async (_env: unknown, entry: unknown) => {
    audited.push(entry);
  },
}));

const T = 1_800_000_000_000; // a whole 10-minute window
const HTTP: Surface = {
  kind: "http",
  client: { ip: "192.0.2.1", host: "api.hosted.test" },
};
const MCP: Surface = {
  kind: "mcp",
  tool: "list_installs",
  clientVersion: null,
};
const token = (n: string, scopes: Principal["scopes"] = []): Principal => ({
  kind: "token",
  actorKey: `token:${n}`,
  rateKey: `admin:${n}@example.com`,
  label: "ci",
  scopes,
  email: `${n}@example.com`,
  tokenId: n,
  authAt: null,
});
const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => (e instanceof ApiError ? e.code : e),
  );

beforeEach(() => {
  audited.length = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("invokeRoute refusals are recorded (4.9)", () => {
  it("a 429 is counted in audit_refusals, bucket auth, by the rate key's HMAC", async () => {
    const db = await platformDb();
    const p = token(crypto.randomUUID());
    const { env, limits } = fakeEnv({ PLATFORM_DB: db });
    limits.RL_PV_READ.allow = false;
    limits.RL_PV_WRITE.allow = false;
    for (const s of [HTTP, MCP])
      expect(await codeOf(invokeRoute(env, ctx(), p, "R2", {}, s))).toBe(
        "rate_limited",
      );
    expect(await codeOf(invokeRoute(env, ctx(), p, "R7", {}, HTTP))).toBe(
      "rate_limited",
    );
    const rows = await db
      .prepare(
        "SELECT bucket, code, window_start, count FROM audit_refusals WHERE ip_hmac = ?1",
      )
      .bind(await hmac16(env.ADMIN_SESSION_KEY, p.rateKey))
      .all();
    expect(rows.results).toEqual([
      { bucket: "auth", code: "rate_limited", window_start: T, count: 3 },
    ]);
  });

  it("a failed count never changes the answer", async () => {
    const { env, limits } = fakeEnv();
    limits.RL_PV_READ.allow = false;
    expect(
      await codeOf(invokeRoute(env, ctx(), token("x"), "R2", {}, HTTP)),
    ).toBe("rate_limited");
  });

  it("an authz refusal writes authz.refused (route, code), on both surfaces", async () => {
    const { env } = fakeEnv();
    const p = token("y", ["installs:read"]);
    for (const s of [HTTP, MCP])
      expect(await codeOf(invokeRoute(env, ctx(), p, "R19", {}, s))).toBe(
        "forbidden",
      );
    expect(audited).toEqual(
      [HTTP, MCP].map(
        (surface): AuditEntry => ({
          action: "authz.refused",
          actor: p,
          outcome: "refused",
          route: "R19",
          code: "forbidden",
          surface,
        }),
      ),
    );
  });

  it("an allowed call writes no authz.refused", async () => {
    const { env } = fakeEnv();
    await invokeRoute(
      env,
      ctx(),
      token("z", ["installs:read"]),
      "R2",
      {},
      HTTP,
    );
    expect(audited).toEqual([]);
  });
});
