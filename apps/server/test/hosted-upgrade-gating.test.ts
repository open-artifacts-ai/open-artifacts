// Review item 39: a hosted tenant never sees the self-host upgrade path.
// HOSTED=1 nulls Me.instance.update, drops the skill's upgrade line, 404s
// /upgrade.md and skips the cron's daily GitHub release check. Self-host
// keeps all four.
import { env } from "cloudflare:workers";
import { MeSchema, newId, R } from "@oa/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduled } from "../src/cron.js";
import { renderSkill } from "../src/mcp/skill.js";
import { RELEASE_KEY, RELEASES_API } from "../src/services/release.js";
import { login } from "./helpers.js";
import { APP, callWorker, E } from "./mcp-helpers.js";

const tag = newId().slice(0, 6).toLowerCase();
const HOSTED = { HOSTED: "1" };

afterEach(() => vi.restoreAllMocks());

const seedRelease = () =>
  env.DB.prepare(
    "insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value",
  )
    .bind(
      RELEASE_KEY,
      JSON.stringify({
        tag: "v999.0.0",
        version: "999.0.0",
        notesUrl: "https://github.com/x",
        breakingVersions: [],
        coveredFrom: null,
        checkedAt: 1,
        checkError: null,
        errorAt: null,
      }),
    )
    .run();

const meOf = async (cookie: string, over: Record<string, unknown> = {}) => {
  const r = await callWorker(
    new Request(`${APP}${R.me}`, { headers: { cookie } }),
    E(over),
  );
  expect(r.status).toBe(200);
  return MeSchema.parse(await r.json());
};

describe("item 39: hosted gating of the upgrade path", () => {
  it("Me.instance.update: null for a hosted owner, set on self-host", async () => {
    await seedRelease();
    const { cookie } = await login(`up-own-${tag}@x.com`, "owner");
    expect((await meOf(cookie)).instance.update).toMatchObject({
      latestVersion: "999.0.0",
    });
    expect((await meOf(cookie, HOSTED)).instance.update).toBeNull();
  });

  it("skill.md: no upgrade line on HOSTED=1; self-host keeps it", async () => {
    const base = {
      APP_HOST: "up.example.com",
      ENVIRONMENT: "production",
      PLAN: "free",
    } as const;
    const self = await renderSkill(base);
    expect(self).toContain(
      "To upgrade this instance to the latest release: https://up.example.com/upgrade.md.\n\nOpen Artifacts hosts",
    );
    const hosted = await renderSkill({ ...base, HOSTED: "1" });
    expect(hosted).not.toContain("upgrade.md");
    expect(hosted).not.toContain("To upgrade this instance");
    expect(hosted).toContain(
      "replace this skill with it.\n\nOpen Artifacts hosts",
    );
    // The served skill too (and its ETag differs, so caches don't mix them).
    const r = await callWorker(new Request(`${APP}/skill.md`), E(HOSTED));
    expect(r.status).toBe(200);
    expect(await r.text()).not.toContain("upgrade.md");
    const s = await callWorker(new Request(`${APP}/skill.md`), E());
    expect(await s.text()).toContain("/upgrade.md");
    expect(r.headers.get("etag")).not.toBe(s.headers.get("etag"));
  });

  it("GET and HEAD /upgrade.md: 404 on HOSTED=1, 200 on self-host", async () => {
    for (const method of ["GET", "HEAD"]) {
      const h = await callWorker(
        new Request(`${APP}/upgrade.md`, { method }),
        E(HOSTED),
      );
      expect(h.status, method).toBe(404);
      const s = await callWorker(
        new Request(`${APP}/upgrade.md`, { method }),
        E(),
      );
      expect(s.status, method).toBe(200);
    }
  });

  it("the daily cron skips the release check on HOSTED=1 only", async () => {
    const run = async (e: unknown) => {
      const waits: Promise<unknown>[] = [];
      const ctx = {
        waitUntil: (p: Promise<unknown>) => waits.push(p),
        passThroughOnException() {},
      } as unknown as ExecutionContext;
      const f = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () => new Response("", { status: 500 }));
      await scheduled({ cron: "17 3 * * *" }, e as typeof env, ctx);
      await Promise.all(waits);
      const urls = f.mock.calls.map((c) => String(c[0]));
      f.mockRestore();
      return urls;
    };
    expect(await run(E(HOSTED))).not.toContain(RELEASES_API);
    expect(await run(E())).toContain(RELEASES_API);
  });
});
