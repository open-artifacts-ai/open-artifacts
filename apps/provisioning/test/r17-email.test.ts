import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Surface } from "../src/routes/invoke.js";
import { REDACTED_LABEL } from "../src/services/pii.js";
import { call, HTTP } from "./call.js";
import { fakeEnv, insert, resetDb, seedInstall, tokenP } from "./fakes.js";

// The R17 email rule (9A.8), end to end through invokeRoute on both
// surfaces: a token without installs:pii sees no email anywhere in a row,
// by value (unlisted keys, nested, embedded in text), on every source.

const NOW = Date.UTC(2026, 9, 31, 12);
const MCP: Surface = { kind: "mcp", tool: "query_audit", clientVersion: null };
const NO_PII = tokenP(["audit:read"]);
const PII = tokenP(["audit:read", "installs:pii"]);

beforeEach(async () => {
  await resetDb();
  vi.spyOn(Date, "now").mockImplementation(() => NOW);
});
afterEach(() => vi.restoreAllMocks());

async function seed() {
  const { id } = await seedInstall();
  await insert("admin_audit", {
    at: NOW - 3,
    actor_kind: "admin",
    actor_label: "other@example.com",
    action: "job.accepted",
    install_id: id,
    outcome: "ok",
    detail: JSON.stringify({
      admin: "other@example.com",
      contact: "x@acme.test",
      note: "asked by Owner <o@acme.test>",
      nested: { to: ["y@acme.test", "keep"] },
      kind: "create",
    }),
  });
  await insert("hosted_audit", {
    at: NOW - 2,
    install_id: id,
    action: "job.done",
    detail: JSON.stringify({
      error: "mail to z@acme.test bounced",
      code: null,
    }),
  });
  await insert("admin_audit", {
    at: NOW - 1,
    actor_kind: "token",
    actor_label: "ci-bot",
    token_id: NO_PII.tokenId,
    action: "token.used",
    install_id: id,
    outcome: "ok",
    detail: JSON.stringify({ admin: NO_PII.email, route: "R2" }),
  });
  return id;
}

// biome-ignore lint/suspicious/noExplicitAny: test reads arbitrary JSON
const bySource = (items: any[], a: string): any =>
  items.find((x) => x.action === a);

describe("R17 email rule (9A.8), both surfaces", () => {
  for (const s of [HTTP, MCP])
    it(`${s.kind}: no email in any row for a token without installs:pii`, async () => {
      const id = await seed();
      const r = await call(
        fakeEnv(),
        NO_PII,
        "R17",
        { query: { installId: id } },
        s,
      );
      expect(r.status).toBe(200);
      expect(JSON.stringify(r.body)).not.toMatch(/@acme\.test|other@example/);
      const job = bySource(r.body.items, "job.accepted");
      expect(job.actor.label).toBe(REDACTED_LABEL);
      expect(job.detail).toEqual({
        admin: null,
        contact: null,
        note: null,
        nested: { to: [null, "keep"] },
        kind: "create",
      });
      expect(bySource(r.body.items, "job.done").detail).toEqual({
        error: null,
        code: null,
      });
      // The caller's own minting admin stays (9A.8).
      expect(bySource(r.body.items, "token.used").detail.admin).toBe(
        NO_PII.email,
      );
    });

  it("installs:pii sees every value", async () => {
    const id = await seed();
    const r = await call(fakeEnv(), PII, "R17", { query: { installId: id } });
    const job = bySource(r.body.items, "job.accepted");
    expect(job.actor.label).toBe("other@example.com");
    expect(job.detail.note).toBe("asked by Owner <o@acme.test>");
    expect(bySource(r.body.items, "job.done").detail.error).toBe(
      "mail to z@acme.test bounced",
    );
  });
});
