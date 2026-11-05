import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import { InfraError, setupTimeout } from "../../src/fetch-timeout.ts";
import { SetupHookError } from "../../src/http.ts";
import { NotRefused, tagLeg } from "../../src/refused.ts";
import { label, type ProofMeta, proof } from "../../src/report.ts";
import { watchResets } from "../../src/resets.ts";
import { transportFetch } from "../../src/transport.ts";

// Driven by report.test.ts: FIXTURE_LEVEL picks the second case's level
// ("setup-fail" fails the top beforeAll; "nested-setup-fail" fails the
// beforeAll of an outer suite around a nested one; "labeled" labels the
// nested case from a beforeEach, as live/signin.test.ts does; "infra" and
// "setup-infra" throw a setup-publish timeout from the case or the top
// beforeAll; "setup-hook" refuses the top beforeAll's session hook with a
// reason, as the seeding's hook did in staging run 6; "setup-hook-more" also
// fails the afterAll on a second infra error; "setup-no-response" throws a
// transport-tagged no-response error, not an InfraError, from the top
// beforeAll, as a setup fetch's reset did in run 41919316028 (#1133)).
const LEVEL = process.env.FIXTURE_LEVEL ?? "pass";

beforeAll(async () => {
  if (LEVEL === "setup-fail") throw new Error("fixture setup");
  if (LEVEL === "setup-infra")
    throw new InfraError(setupTimeout("rl-b", 60_000));
  // Thrown as fetch threw it: only its tag (a property) says infra, so this
  // proves the tag survives vitest's serialization of a module error.
  if (LEVEL === "setup-no-response") throw await noResponse();
  if (LEVEL === "setup-hook" || LEVEL === "setup-hook-more") {
    // The body also carries text that must never reach the report.
    const body = JSON.stringify({
      error: {
        code: "not_found",
        message: "Not found leaked-body-text",
        details: { reason: "spaces_blocked" },
      },
    });
    throw new SetupHookError(
      { name: "rl-a" } as never,
      "/__test/session",
      new Response(body, { status: 404 }),
      body,
    );
  }
});

afterAll(() => {
  if (LEVEL === "setup-hook-more")
    throw new InfraError(setupTimeout("rl-b", 60_000));
});

it("fixture: a passing case", () => {});

/** The error a GET to a server that resets every socket rejects with. */
async function noResponse(): Promise<unknown> {
  const server = createServer((req) => req.socket.resetAndDestroy());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  try {
    await transportFetch(globalThis.fetch, watchResets())(
      `http://127.0.0.1:${port}/x`,
      { signal: AbortSignal.timeout(5_000) },
    );
  } catch (e) {
    return e;
  } finally {
    server.closeAllConnections();
    server.close();
  }
  throw new Error("fixture: the reset server answered");
}

it("fixture: the case under test", async (ctx) => {
  if (LEVEL === "fail") throw new Error("fixture failure");
  // A failure whose message carries every kind of secret (redacted in the report).
  if (LEVEL === "secret-fail")
    throw new Error(
      "rl-b callback http://rl-b.app.localhost:8787/auth/callback/google?state=st0123456789abcdefghij&code=4/0AeanS0123456789abcdef&bstate=eyJpIjoicmwtYSJ9.SIGsig for alice@oa-redline-a.fyi with cookie oa_oidc_ab12=v4lu3s3cr3t; Bearer oa_pat_0123456789abcdefghijklmn token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
    );
  // crossCheck's refused leg failing: the report gets leg, host, expected, actual.
  if (LEVEL === "leg-fail")
    throw tagLeg(
      new NotRefused(
        "rl-b did not refuse the sign-in (status 302, body sha256:0011223344556677 (0 bytes); to /)",
      ),
      {
        leg: "A's credential at B",
        host: "rl-b",
        expected: "refused at sign-in (error=tenant, no session)",
      },
    );
  if (LEVEL === "infra") throw new InfraError(setupTimeout("rl-b", 60_000));
  // #1133: a case-body fetch that got no response (a local server resets
  // the socket), sent through transportFetch as live/setup.ts does. Thrown
  // as is: infra. Caught and judged by an assertion instead: fail.
  if (LEVEL === "no-response" || LEVEL === "no-response-asserted") {
    const e = await noResponse();
    if (LEVEL === "no-response") throw e;
    throw new Error(`expected a response, got ${(e as Error).message}`);
  }
  if (["staging-only", "not-applicable", "unproven-live"].includes(LEVEL))
    proof(ctx, LEVEL as ProofMeta["level"], "fixture");
});

describe("outer", () => {
  beforeAll(() => {
    if (LEVEL === "nested-setup-fail") throw new Error("fixture outer setup");
  });
  describe("inner", () => {
    beforeEach((ctx) => {
      if (LEVEL === "labeled") label(ctx, "Turnstile test key");
    });
    it("fixture: a nested case", () => {});
  });
});
