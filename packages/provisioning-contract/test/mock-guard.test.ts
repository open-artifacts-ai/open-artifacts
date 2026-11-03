// #1188: the admin mock answers as the Provisioning API on what the route table
// says: every mocked GET parses with its response schema, the query schema
// refuses what the API refuses (with the API's body), cursors are opaque and
// tied to their query, R17 filters, and R28 answers 201.
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_IDS } from "../src/fixtures.js";
import {
  ROUTE_IDS,
  ROUTES,
  type RouteId,
  TestAdminSessionResultSchema,
} from "../src/index.js";
import { createProvisioningMock } from "../src/mocks.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const B = "https://admin.open-artifacts.app/api/v1";
const use = () => server.use(...createProvisioningMock().handlers);
const get = async (path: string) => {
  const r = await fetch(`${B}${path}`);
  return { status: r.status, body: (await r.json()) as any };
};

/** A request for every GET the mock answers (R26 and the browser routes aside). */
const SAMPLE: Partial<Record<RouteId, string>> = {
  R1: "/me",
  R2: "/installs",
  R3: `/installs/${FIXTURE_IDS.leo}`,
  R14: `/installs/${FIXTURE_IDS.leo}/jobs`,
  R15: `/jobs/${FIXTURE_IDS.jobLeo}`,
  R16: "/releases",
  R17: "/audit",
  R18: "/slugs/acme",
  R20: "/tokens",
  R27: "/world",
};
const GETS = ROUTE_IDS.filter(
  (id) => ROUTES[id].method === "GET" && ROUTES[id].base === "api",
);

describe("every mocked GET parses with its route's response schema", () => {
  it("covers every api GET in the table", () => {
    expect(GETS.filter((id) => !SAMPLE[id])).toEqual([]);
  });
  it.each(GETS)("%s", async (id) => {
    use();
    const r = await get(SAMPLE[id] as string);
    expect(r.status).toBe(ROUTES[id].status);
    const schema = ROUTES[id].response as { strict?: () => unknown };
    expect(ROUTES[id].response.safeParse(r.body).success).toBe(true);
    if (typeof schema.strict === "function")
      expect(
        (schema.strict() as typeof ROUTES.R1.response).safeParse(r.body)
          .success,
      ).toBe(true);
  });
});

describe("the query schema refuses as the API does", () => {
  it.each([
    ["/installs?state=bogus", ["query.state"]],
    ["/installs?source=nope", ["query.source"]],
    [`/installs?q=${"x".repeat(101)}`, ["query.q"]],
    ["/installs?limit=0", ["query.limit"]],
    ["/installs?limit=500", ["query.limit"]],
    [`/installs/${FIXTURE_IDS.leo}/jobs?limit=0`, ["query.limit"]],
    ["/audit?installId=nope", ["query.installId"]],
    [`/audit?action=${"a".repeat(101)}`, ["query.action"]],
  ])("%s", async (path, fields) => {
    use();
    expect(await get(path)).toEqual({
      status: 400,
      body: {
        error: {
          code: "invalid_input",
          message: "invalid input",
          details: { fields },
        },
      },
    });
  });
});

describe("cursors are opaque and belong to their query", () => {
  const BAD = {
    status: 400,
    body: { error: { code: "invalid_input", message: "bad cursor" } },
  };
  it("a garbage cursor is the API's bad cursor", async () => {
    use();
    for (const c of ["garbage", "1", "eyJxIjoxfQ"])
      expect(await get(`/installs?cursor=${c}`)).toEqual(BAD);
  });
  it("one page leads to the next; another query can't use it", async () => {
    use();
    const first = await get("/installs?limit=1");
    expect(first.body.items).toHaveLength(1);
    const c = first.body.nextCursor as string;
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    const next = await get(`/installs?limit=1&cursor=${c}`);
    expect(next.status).toBe(200);
    expect(next.body.items[0].id).not.toBe(first.body.items[0].id);
    expect(await get(`/installs?limit=1&state=active&cursor=${c}`)).toEqual(
      BAD,
    );
    expect(await get(`/audit?cursor=${c}`)).toEqual(BAD);
  });
});

describe("R17 filters", () => {
  const ids = async (q: string) =>
    ((await get(`/audit${q}`)).body.items as { id: string }[]).map((e) => e.id);
  it.each([
    ["", ["api:3", "prov:2", "api:1"]],
    [`?installId=${FIXTURE_IDS.acme}`, ["api:3"]],
    ["?action=job.failed", ["prov:2"]],
    ["?actor=admin@example.com", ["api:3"]],
    [`?actor=token:${FIXTURE_IDS.token}`, ["api:1"]],
    ["?actor=token:01JD7Z9W5Q8X3N4M2K1H0G9F8Z", []],
    [`?installId=${FIXTURE_IDS.leo}&action=install.suspend`, []],
  ])("%s", async (q, want) => {
    use();
    expect(await ids(q)).toEqual(want);
  });
});

describe("R28 test admin session", () => {
  it("201 with the sealed sid and its end", async () => {
    use();
    const r = await fetch(`${B}/test-admin/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipientKey: `${"A".repeat(42)}A` }),
    });
    expect(r.status).toBe(201);
    expect(TestAdminSessionResultSchema.safeParse(await r.json()).success).toBe(
      true,
    );
  });
  it("a bad recipientKey is the API's invalid input", async () => {
    use();
    const r = await fetch(`${B}/test-admin/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipientKey: "nope" }),
    });
    expect({ status: r.status, body: await r.json() }).toEqual({
      status: 400,
      body: {
        error: {
          code: "invalid_input",
          message: "invalid input",
          details: { fields: ["body.recipientKey"] },
        },
      },
    });
  });
});
