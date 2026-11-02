import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { readSession, sessionCookieName } from "../src/auth/session.js";
import type { Env } from "../src/env.js";

const app = createApp();
const SESSION = sessionCookieName(env);
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const call = (path: string, e: Env = env) =>
  app.fetch(new Request(`http://app.localhost${path}`), e, ctx);
const sessionOf = (r: Response) =>
  r.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${SESSION}=`))
    ?.slice(`${SESSION}=`.length)
    .split(";")[0];

describe("GET /auth/dev-login", () => {
  it("404 outside dev", async () => {
    for (const ENVIRONMENT of ["production", "staging", ""] as const) {
      const r = await call("/auth/dev-login?email=a@x.com", {
        ...env,
        ENVIRONMENT: ENVIRONMENT as Env["ENVIRONMENT"],
      });
      expect(r.status).toBe(404);
      expect(sessionOf(r)).toBeUndefined();
    }
  });

  it("refuses an address that isn't one, like the placeholder a deletion leaves", async () => {
    for (const email of ["nope", "removed+abc@invalid"]) {
      const r = await call(
        `/auth/dev-login?email=${encodeURIComponent(email)}`,
      );
      expect(r.status).toBe(400);
      expect(sessionOf(r)).toBeUndefined();
    }
  });

  it("dev → 302 and sets the session cookie (default role member)", async () => {
    const r = await call("/auth/dev-login?email=Dev@X.com");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/");
    const s = await readSession(env, sessionOf(r));
    const row = await env.DB.prepare("select * from users where email = ?")
      .bind("dev@x.com")
      .first<{ id: string; role: string }>();
    expect(row?.role).toBe("member");
    expect(s?.uid).toBe(row?.id);
  });

  it("honours role and next; re-login updates role", async () => {
    const r = await call(
      "/auth/dev-login?email=adm@x.com&role=admin&next=/a/q",
    );
    expect(r.headers.get("location")).toBe("/a/q");
    await call("/auth/dev-login?email=adm@x.com&role=guest");
    const row = await env.DB.prepare("select role from users where email = ?")
      .bind("adm@x.com")
      .first<{ role: string }>();
    expect(row?.role).toBe("guest");
    expect(
      (await call("/auth/dev-login?email=e@x.com&next=//evil.com")).headers.get(
        "location",
      ),
    ).toBe("/");
  });

  it("dev-login Location never escapes origin", async () => {
    for (const n of [
      "/..//evil.com",
      "/.//evil.com",
      "/a/..//evil.com",
      "/a/..\\/evil.com",
      "/%2e%2e//evil.com",
    ]) {
      const r = await call(
        `/auth/dev-login?email=redir@x.com&next=${encodeURIComponent(n)}`,
      );
      expect(r.headers.get("location")).toBe("/");
    }
  });

  it("rejects non-ASCII email (Kelvin sign) with 400", async () => {
    const r = await call(
      `/auth/dev-login?email=${encodeURIComponent("\u212Aim@x.com")}`,
    );
    expect(r.status).toBe(400);
  });

  it("rejects bad role and bad email with 400", async () => {
    expect((await call("/auth/dev-login?email=a@x.com&role=root")).status).toBe(
      400,
    );
    expect((await call("/auth/dev-login?email=nope")).status).toBe(400);
    expect((await call("/auth/dev-login")).status).toBe(400);
  });
});
