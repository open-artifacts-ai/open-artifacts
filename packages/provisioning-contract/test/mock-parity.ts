// #1188: the cases the provisioning MSW mock and the real worker must answer
// alike, for R2, R14 and R17's filters and paging. Run by two drivers: the
// mock (mock-parity.test.ts here) and the worker through invokeRoute, on D1
// seeded with the mock's own world (apps/provisioning/test/mock-parity.test.ts).
// They compare status, error code and body shape (the route's response
// schema), plus the ids or actions each answer lists; never whole bodies, so
// timestamps and generated ids can't flake. Tagged the hosted contract's way:
// a case one driver fails today is in its knownGaps (it.fails, so a fix that
// makes it pass fails until the entry goes); an MSW-only case is skipped on
// the worker with its reason.
import { describe, expect, it } from "vitest";
import { FIXTURE_IDS } from "../src/fixtures.js";
import { ROUTES } from "../src/routes.js";

export type ParityRoute = "R2" | "R14" | "R17";
export type ParityAnswer = {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: test reads arbitrary JSON
  body: any;
};
export type KnownGap = { why: string };
export type ParityDriver = {
  /** Runs the MSW-only cases (true for the mock). */
  mock: boolean;
  /** The mock's starting world, as an admin with pii. */
  fresh: () => Promise<void>;
  /** One read, the route's params and query as strings. */
  call: (
    route: ParityRoute,
    input?: {
      params?: Record<string, string>;
      query?: Record<string, string>;
    },
  ) => Promise<ParityAnswer>;
  /** Adds a create still waiting on its signup (the worker only can). */
  addPendingSignup: (slug: string, email: string) => Promise<void>;
  knownGaps?: Readonly<Record<string, KnownGap>>;
};

const { leo, acme, broken, jobLeo, jobBroken, token } = FIXTURE_IDS;

/** Registers the cases against `d`; returns their names. */
export function mockParity(d: ParityDriver): string[] {
  const names: string[] = [];
  const t = (name: string, fn: () => Promise<void>, mswOnly?: string) => {
    if (names.includes(name)) throw new Error(`duplicate case: ${name}`);
    names.push(name);
    if (mswOnly && !d.mock) it.skip(`${name} [MSW-only: ${mswOnly}]`, fn);
    else if (d.knownGaps?.[name])
      it.fails(`${name} [known gap: ${d.knownGaps[name].why}]`, fn);
    else it(name, fn);
  };

  /** A 200 whose body parses with the route's response schema. */
  const ok = async (
    route: ParityRoute,
    input?: Parameters<ParityDriver["call"]>[1],
  ) => {
    const r = await d.call(route, input);
    expect(r.status).toBe(200);
    expect(ROUTES[route].response.safeParse(r.body).success).toBe(true);
    return r.body as {
      items: Record<string, unknown>[];
      nextCursor: string | null;
    };
  };
  /** A refusal: its status and code, never its message. */
  const refused = async (
    route: ParityRoute,
    input: Parameters<ParityDriver["call"]>[1],
    status: number,
    code: string,
  ) => {
    const r = await d.call(route, input);
    expect({ status: r.status, code: r.body?.error?.code }).toEqual({
      status,
      code,
    });
  };
  const ids = async (query: Record<string, string>) =>
    (await ok("R2", { query })).items.map((i) => i.id);
  const jobs = async (id: string, query: Record<string, string> = {}) =>
    (await ok("R14", { params: { id }, query })).items.map((j) => j.id);
  const actions = async (query: Record<string, string>) =>
    (await ok("R17", { query })).items.map((e) => e.action);

  describe("R2 installs", () => {
    const at = (name: string, query: Record<string, string>, want: string[]) =>
      t(name, async () => {
        await d.fresh();
        expect(await ids(query)).toEqual(want);
      });
    at("R2: all, newest first", {}, [leo, acme, broken]);
    at("R2: state=active", { state: "active" }, [leo, acme]);
    at("R2: state=failed", { state: "failed" }, [broken]);
    at("R2: source=admin", { source: "admin" }, [leo, acme, broken]);
    at("R2: source=self-serve", { source: "self-serve" }, []);
    at("R2: q on the slug, any case", { q: "ACME" }, [acme]);
    at("R2: q on a stored host", { q: "leo.open-artifacts" }, [leo]);
    at("R2: q on the id", { q: broken.slice(1, 7) }, [broken]);
    at("R2: q on the owner email", { q: "owner@example" }, [leo, acme, broken]);
    at("R2: q's wildcards are literal", { q: "%" }, []);
    at("R2: q and state together", { q: "acme", state: "failed" }, []);
    at("R2: q matching nothing", { q: "nope-nothing" }, []);
    t("R2: q on a pending signup's email", async () => {
      await d.fresh();
      await d.addPendingSignup("pend", "waiting@pending.test");
      expect(await ids({ q: "waiting@pending" })).toHaveLength(1);
    });
    t("R2: limit pages, and the cursor leads on", async () => {
      await d.fresh();
      const first = await ok("R2", { query: { limit: "1" } });
      expect(first.items.map((i) => i.id)).toEqual([leo]);
      expect(typeof first.nextCursor).toBe("string");
      const next = await ok("R2", {
        query: { limit: "1", cursor: first.nextCursor as string },
      });
      expect(next.items.map((i) => i.id)).toEqual([acme]);
    });
    t("R2: a cursor from another query is invalid_input", async () => {
      await d.fresh();
      const first = await ok("R2", { query: { limit: "1" } });
      await refused(
        "R2",
        {
          query: {
            limit: "1",
            state: "active",
            cursor: first.nextCursor as string,
          },
        },
        400,
        "invalid_input",
      );
    });
    const bad = (name: string, query: Record<string, string>) =>
      t(name, async () => {
        await d.fresh();
        await refused("R2", { query }, 400, "invalid_input");
      });
    bad("R2: a garbage cursor is invalid_input", { cursor: "garbage" });
    bad("R2: an unknown state is invalid_input", { state: "bogus" });
    bad("R2: an unknown source is invalid_input", { source: "nope" });
    bad("R2: limit 0 is invalid_input", { limit: "0" });
    bad("R2: limit over the max is invalid_input", { limit: "500" });
    bad("R2: q over 100 characters is invalid_input", { q: "x".repeat(101) });
  });

  describe("R14 an install's jobs", () => {
    t("R14: leo's jobs", async () => {
      await d.fresh();
      expect(await jobs(leo)).toEqual([jobLeo]);
    });
    t("R14: broken's jobs", async () => {
      await d.fresh();
      expect(await jobs(broken)).toEqual([jobBroken]);
    });
    t("R14: an install with none", async () => {
      await d.fresh();
      expect(await jobs(acme)).toEqual([]);
    });
    t("R14: an unknown install is not_found", async () => {
      await d.fresh();
      await refused(
        "R14",
        { params: { id: "inoneabcdefg" } },
        404,
        "not_found",
      );
    });
    t("R14: limit 0 is invalid_input", async () => {
      await d.fresh();
      await refused(
        "R14",
        { params: { id: leo }, query: { limit: "0" } },
        400,
        "invalid_input",
      );
    });
    t("R14: a garbage cursor is invalid_input", async () => {
      await d.fresh();
      await refused(
        "R14",
        { params: { id: leo }, query: { cursor: "garbage" } },
        400,
        "invalid_input",
      );
    });
  });

  describe("R17 audit", () => {
    const at = (name: string, query: Record<string, string>, want: string[]) =>
      t(name, async () => {
        await d.fresh();
        expect(await actions(query)).toEqual(want);
      });
    at("R17: all, newest first", {}, [
      "install.suspend",
      "job.failed",
      "job.accepted",
    ]);
    at("R17: installId", { installId: acme }, ["install.suspend"]);
    at("R17: action", { action: "job.failed" }, ["job.failed"]);
    at("R17: actor by label", { actor: "admin@example.com" }, [
      "install.suspend",
    ]);
    at("R17: actor token:<id>", { actor: `token:${token}` }, ["job.accepted"]);
    at(
      "R17: actor token:<another id>",
      { actor: "token:01JD7Z9W5Q8X3N4M2K1H0G9F8Z" },
      [],
    );
    at(
      "R17: installId and action together",
      { installId: leo, action: "install.suspend" },
      [],
    );
    t("R17: limit pages, and the cursor leads on", async () => {
      await d.fresh();
      const first = await ok("R17", { query: { limit: "2" } });
      expect(first.items.map((e) => e.action)).toEqual([
        "install.suspend",
        "job.failed",
      ]);
      const next = await ok("R17", {
        query: { limit: "2", cursor: first.nextCursor as string },
      });
      expect(next.items.map((e) => e.action)).toEqual(["job.accepted"]);
      expect(next.nextCursor).toBeNull();
    });
    const bad = (name: string, query: Record<string, string>) =>
      t(name, async () => {
        await d.fresh();
        await refused("R17", { query }, 400, "invalid_input");
      });
    bad("R17: a bad installId is invalid_input", { installId: "nope" });
    bad("R17: a garbage cursor is invalid_input", { cursor: "garbage" });
    bad("R17: action over 100 characters is invalid_input", {
      action: "a".repeat(101),
    });
  });
  return names;
}
