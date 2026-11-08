// B3: the daily latest-release check and Me.instance.update.
import { env } from "cloudflare:workers";
import { MeSchema, newId, R } from "@oa/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { scheduled } from "../src/cron.js";
import {
  checkLatestRelease,
  instanceUpdate,
  parseSemver,
  RELEASE_KEY,
  RELEASE_LATEST_HTML,
  RELEASES_API,
} from "../src/services/release.js";
import { api, login } from "./helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
const NOTES =
  "https://github.com/open-artifacts-ai/open-artifacts/releases/tag/";

const stored = async () => {
  const r = await env.DB.prepare("select value from settings where key = ?")
    .bind(RELEASE_KEY)
    .first<{ value: string }>();
  return r ? JSON.parse(r.value) : null;
};
const rel = (t: string, over: Record<string, unknown> = {}) => ({
  tag_name: t,
  published_at: `2026-10-19T12:00:00Z`,
  html_url: "https://evil.example/x",
  draft: false,
  prerelease: false,
  body: "## Features\n* thing",
  ...over,
});
const list = () =>
  Response.json([
    rel("v0.5.0-rc.1", { prerelease: true, body: "BREAKING CHANGE: rc" }),
    rel("v0.4.1"),
    rel("v0.4.0", { body: "### ⚠ BREAKING CHANGES\n* x" }),
    rel("v0.3.0"),
    rel("nightly", { body: "BREAKING CHANGE" }),
  ]);
const redirect = (t: string) =>
  new Response(null, { status: 302, headers: { location: NOTES + t } });

/** Routes the API and the HTML fallback separately. */
const fetchOf = (
  apiRes: () => Response | Promise<Response>,
  htmlRes: () => Response | Promise<Response> = () =>
    new Response("", { status: 500 }),
) =>
  vi.fn(async (u: RequestInfo | URL, _i?: RequestInit) =>
    String(u) === RELEASE_LATEST_HTML ? htmlRes() : apiRes(),
  );
const asFetch = (f: ReturnType<typeof fetchOf>) => f as unknown as typeof fetch;

beforeEach(async () => {
  await env.DB.prepare("delete from settings where key = ?")
    .bind(RELEASE_KEY)
    .run();
});

describe("checkLatestRelease", () => {
  it("one list call: latest stable, breaking stable versions, notesUrl", async () => {
    const f = fetchOf(list);
    await checkLatestRelease(env, 1000, asFetch(f));
    expect(f).toHaveBeenCalledOnce();
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(RELEASES_API);
    const h = new Headers(init.headers);
    expect(h.get("user-agent")).toMatch(/^open-artifacts\//);
    expect(h.get("authorization")).toBeNull();
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(await stored()).toEqual({
      tag: "v0.4.1",
      version: "0.4.1",
      publishedAt: "2026-10-19T12:00:00Z",
      notesUrl: `${NOTES}v0.4.1`,
      breakingVersions: ["0.4.0"],
      coveredFrom: null,
      checkedAt: 1000,
      checkError: null,
      errorAt: null,
    });
  });

  it("a full page records the oldest version it covers", async () => {
    const page = Array.from({ length: 100 }, (_, i) => rel(`v1.0.${100 - i}`));
    await checkLatestRelease(
      env,
      1,
      asFetch(fetchOf(() => Response.json(page))),
    );
    expect(await stored()).toMatchObject({
      version: "1.0.100",
      coveredFrom: "1.0.1",
    });
  });

  it.each([403, 429])(
    "%s falls back to the /releases/latest redirect",
    async (st) => {
      const f = fetchOf(
        () => new Response("rate", { status: st }),
        () => redirect("v0.6.0"),
      );
      await checkLatestRelease(env, 7, asFetch(f));
      const [url, init] = f.mock.calls[1] as [string, RequestInit];
      expect(url).toBe(RELEASE_LATEST_HTML);
      expect(init.redirect).toBe("manual");
      expect(await stored()).toEqual({
        tag: "v0.6.0",
        version: "0.6.0",
        publishedAt: null,
        notesUrl: `${NOTES}v0.6.0`,
        breakingVersions: null,
        coveredFrom: null,
        checkedAt: 7,
        checkError: null,
        errorAt: null,
      });
    },
  );

  it("the fallback keeps the breaking list while latest is unchanged", async () => {
    await checkLatestRelease(env, 1, asFetch(fetchOf(list)));
    await checkLatestRelease(
      env,
      2,
      asFetch(
        fetchOf(
          () => new Response("", { status: 429 }),
          () => redirect("v0.4.1"),
        ),
      ),
    );
    expect(await stored()).toMatchObject({
      version: "0.4.1",
      breakingVersions: ["0.4.0"],
      checkedAt: 2,
    });
  });

  it.each([
    [
      "403, fallback fails",
      () => new Response("", { status: 403 }),
      "rate_limited",
    ],
    ["404", () => new Response("nf", { status: 404 }), "no_release"],
    ["500", () => new Response("x", { status: 500 }), "http_500"],
    ["bad JSON", () => new Response("{not json"), "bad_json"],
    ["not a list", () => Response.json({ tag_name: "v1.0.0" }), "bad_json"],
    [
      "no stable semver tag",
      () => Response.json([rel("nightly")]),
      "no_release",
    ],
    [
      "network",
      () => {
        throw new TypeError("fetch failed");
      },
      "network",
    ],
  ] as const)(
    "%s keeps the last good value and records checkError",
    async (_n, f, code) => {
      await checkLatestRelease(env, 1000, asFetch(fetchOf(list)));
      const good = await stored();
      const out = await checkLatestRelease(env, 2000, asFetch(fetchOf(f)));
      expect(out).not.toBeNull();
      expect(await stored()).toEqual({
        ...good,
        checkError: code,
        errorAt: 2000,
      });
    },
  );

  it("a fallback redirect to a non-semver tag is bad_tag", async () => {
    await checkLatestRelease(
      env,
      1,
      asFetch(
        fetchOf(
          () => new Response("", { status: 429 }),
          () => redirect("nightly"),
        ),
      ),
    );
    expect(await stored()).toEqual({ checkError: "bad_tag", errorAt: 1 });
  });

  it("an error before any good check stores only the error", async () => {
    await checkLatestRelease(
      env,
      5,
      asFetch(fetchOf(() => new Response("", { status: 429 }))),
    );
    expect(await stored()).toEqual({ checkError: "rate_limited", errorAt: 5 });
  });

  it("never throws, even when D1 fails", async () => {
    const broken = { ...env, DB: undefined } as never;
    await expect(
      checkLatestRelease(broken, 1, asFetch(fetchOf(list))),
    ).resolves.toBeNull();
  });

  it("runs from the daily cron", async () => {
    const f = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json([rel("v9.9.9")]));
    try {
      const waits: Promise<unknown>[] = [];
      await scheduled({} as ScheduledController, env, {
        waitUntil: (p: Promise<unknown>) => waits.push(p),
        passThroughOnException() {},
      } as unknown as ExecutionContext);
      await Promise.all(waits);
      expect(f).toHaveBeenCalledWith(RELEASES_API, expect.anything());
      expect((await stored()).version).toBe("9.9.9");
    } finally {
      f.mockRestore();
    }
  });
});

describe("instanceUpdate (semver, breaking range, custom builds)", () => {
  const raw = (
    version: string,
    breakingVersions: string[] | null = [],
    coveredFrom: string | null = null,
  ) =>
    JSON.stringify({
      tag: `v${version}`,
      version,
      notesUrl: `${NOTES}v${version}`,
      breakingVersions,
      coveredFrom,
      checkedAt: Date.UTC(2026, 9, 20),
      checkError: null,
      errorAt: null,
    });

  it("parseSemver: plain X.Y.Z only", () => {
    expect(parseSemver("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseSemver("0.10.0")).toEqual([0, 10, 0]);
    expect(parseSemver("1.2.3-dev+abc")).toBeNull();
    expect(parseSemver("1.2")).toBeNull();
    expect(parseSemver("01.2.3")).toBeNull();
  });

  it.each([
    ["0.3.0", "0.4.0", true],
    ["0.3.0", "0.3.0", false],
    ["0.4.0", "0.3.9", false],
    ["0.9.0", "0.10.0", true],
    ["1.0.0", "0.99.99", false],
    ["0.3.1", "0.3.2", true],
  ])("current %s, latest %s -> updateAvailable %s", (cur, latest, want) => {
    expect(instanceUpdate("owner", raw(latest), cur)).toEqual({
      latestVersion: latest,
      current: cur,
      custom: false,
      updateAvailable: want,
      breaking: false,
      notesUrl: `${NOTES}v${latest}`,
      checkedAt: "2026-10-20T00:00:00.000Z",
      latestPublishedAt: null,
    });
  });

  it("latestPublishedAt: the stored publishedAt, else null", () => {
    const withDate = (publishedAt: unknown) =>
      JSON.stringify({
        ...JSON.parse(raw("0.4.0")),
        publishedAt,
      });
    expect(
      instanceUpdate("owner", withDate("2026-10-19T12:00:00Z"), "0.3.0")
        ?.latestPublishedAt,
    ).toBe("2026-10-19T12:00:00Z");
    expect(
      instanceUpdate("owner", withDate(null), "0.3.0")?.latestPublishedAt,
    ).toBeNull();
    expect(
      instanceUpdate("owner", withDate(42), "0.3.0")?.latestPublishedAt,
    ).toBeNull();
    // A custom build gets it too: the notice needs the release's age.
    expect(
      instanceUpdate("owner", withDate("2026-10-19T12:00:00Z"), "0.3.0-dev")
        ?.latestPublishedAt,
    ).toBe("2026-10-19T12:00:00Z");
  });

  it.each([
    // (current, latest]: a breaking 0.4.0 under latest 0.4.1 counts.
    ["0.3.0", "0.4.1", ["0.4.0"], null, true],
    ["0.3.0", "0.4.1", ["0.4.1"], null, true],
    ["0.4.0", "0.4.1", ["0.4.0"], null, false],
    ["0.3.0", "0.4.1", ["0.3.0", "0.5.0"], null, false],
    ["0.4.1", "0.4.1", ["0.4.1"], null, false],
    // Fallback check: unknown.
    ["0.3.0", "0.4.1", null, null, null],
    // Older than the 100-release page: unknown unless a hit is seen.
    ["0.1.0", "0.4.1", [], "0.2.0", null],
    ["0.1.0", "0.4.1", ["0.3.0"], "0.2.0", true],
    ["0.2.0", "0.4.1", [], "0.2.0", false],
  ] as const)(
    "current %s, latest %s, breaking %j from %s -> %s",
    (cur, latest, bv, from, want) => {
      expect(
        instanceUpdate("admin", raw(latest, bv as string[] | null, from), cur)
          ?.breaking,
      ).toBe(want);
    },
  );

  it.each(["0.3.0-dev+abc1234", "0.3.0-dev", "0.2.0-rc.1"])(
    "%s is custom: updateAvailable false, breaking null",
    (cur) => {
      expect(
        instanceUpdate("admin", raw("0.4.0", ["0.4.0"]), cur),
      ).toMatchObject({
        current: cur,
        custom: true,
        updateAvailable: false,
        breaking: null,
      });
    },
  );

  it("null for members and guests, before a good check, and for junk", () => {
    expect(instanceUpdate("member", raw("0.4.0"), "0.3.0")).toBeNull();
    expect(instanceUpdate("guest", raw("0.4.0"), "0.3.0")).toBeNull();
    expect(instanceUpdate("owner", undefined, "0.3.0")).toBeNull();
    expect(instanceUpdate("owner", "{bad", "0.3.0")).toBeNull();
    expect(
      instanceUpdate(
        "owner",
        JSON.stringify({ checkError: "rate_limited", errorAt: 1 }),
        "0.3.0",
      ),
    ).toBeNull();
  });
});

describe("Me.instance.update visibility", () => {
  it("owner and admin see it; member and guest get null", async () => {
    await checkLatestRelease(env, Date.now(), asFetch(fetchOf(list)));
    for (const [role, visible] of [
      ["owner", true],
      ["admin", true],
      ["member", false],
      ["guest", false],
    ] as const) {
      const u = await login(`rel-${role}-${tag}@x.com`, role);
      const r = await api(app, R.me, u.cookie);
      expect(r.status).toBe(200);
      const me = MeSchema.parse(await r.json());
      if (visible)
        expect(me.instance.update).toMatchObject({
          latestVersion: "0.4.1",
          notesUrl: `${NOTES}v0.4.1`,
        });
      else expect(me.instance.update).toBeNull();
    }
  });

  it("null for admins before any check", async () => {
    const u = await login(`rel-none-${tag}@x.com`, "admin");
    const me = MeSchema.parse(await (await api(app, R.me, u.cookie)).json());
    expect(me.instance.update).toBeNull();
  });

  it("GET settings does not leak the release row", async () => {
    await checkLatestRelease(env, 1, asFetch(fetchOf(list)));
    const u = await login(`rel-set-${tag}@x.com`, "owner");
    const body = (await (
      await api(app, R.settings, u.cookie)
    ).json()) as object;
    expect(Object.keys(body).sort()).toEqual(["defaultVisibility", "name"]);
  });
});
