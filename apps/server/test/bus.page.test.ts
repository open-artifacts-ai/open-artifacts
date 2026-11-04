import { env } from "cloudflare:workers";
import type { BusAddress, BusAgent, BusMachine } from "@oa/shared";
import { describe, expect, it } from "vitest";
import designPage from "../../../design/screens/bus.html?raw";
import designRevoke from "../../../design/screens/bus-revoke.html?raw";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import {
  type BusPageDeps,
  dayOf,
  decodeAddress,
  encodeAddress,
  lastUsedOf,
  mountBusPage,
  renderTemplate,
} from "../src/bus/page.js";
import {
  BUS_PAGE_TEMPLATE,
  BUS_REVOKE_TEMPLATE,
  BUS_SNIPPETS,
} from "../src/bus/page-template.js";
import type { Env } from "../src/env.js";
import { ApiError } from "../src/http/errors.js";
import { formCsrf, PAGE_CSP } from "../src/http/pages.js";
import { busSnippetOf, stripTemplateComment } from "../src/mcp/template.js";
import type { BusView } from "../src/services/bus.js";
import { fetchAndWait, login } from "./helpers.js";

const designSnippets = import.meta.glob(
  "../../../design/screens/bus-snippets/*.html",
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

const APP = "http://app.localhost";
const tag = crypto.randomUUID().slice(0, 8);
let n = 0;
const email = (who: string) => `bus-${who}-${tag}-${n++}@x.com`;

const machine = (over: Partial<BusMachine> = {}): BusMachine => ({
  id: `m${n++}`,
  label: "build-box",
  createdAt: "2026-10-25T10:00:00Z",
  lastUsedAt: "2026-11-02T18:10:00Z",
  revokedAt: null,
  connected: true,
  ...over,
});

const agent = (over: Partial<BusAgent> = {}): BusAgent => ({
  id: `a${n++}`,
  namespace: "leo-work",
  name: "claude",
  kind: "claude",
  machineId: "m1",
  machineLabel: "leo-macbook-pro",
  global: false,
  state: "live",
  running: true,
  updatedAt: "2026-11-04T09:00:00Z",
  ...over,
});

type Calls = {
  busView: string[];
  machine: [string, string][];
  revoke: [string, string][];
  get: string[];
  set: [string, unknown][];
};

/** Test doubles for the four deps; each records its calls. */
function doubles(
  o: {
    view?: Partial<BusView>;
    picked?: BusAddress[];
    revoke?: () => Promise<boolean>;
    set?: (agents: unknown) => Promise<BusAddress[]>;
    /** busView and busMachine reject (a D1 failure). */
    readFails?: true;
  } = {},
): { deps: BusPageDeps; calls: Calls } {
  const calls: Calls = {
    busView: [],
    machine: [],
    revoke: [],
    get: [],
    set: [],
  };
  const deps: BusPageDeps = {
    busView: async (_e, uid) => {
      calls.busView.push(uid);
      if (o.readFails) throw new Error("D1 down");
      return { machines: [], agents: [], live: true, ...o.view };
    },
    busMachine: async (_e, uid, id) => {
      calls.machine.push([uid, id]);
      if (o.readFails) throw new Error("D1 down");
      return o.view?.machines?.find((m) => m.id === id) ?? null;
    },
    revokeBusMachine: async (_e, uid, id) => {
      calls.revoke.push([uid, id]);
      // Awaited here: a rejected promise passed through un-awaited is reported
      // as unhandled by workerd before the caller attaches.
      return o.revoke ? await o.revoke() : true;
    },
    getShareNotices: async (_e, uid) => {
      calls.get.push(uid);
      return o.picked ?? [];
    },
    setShareNotices: async (_e, uid, agents) => {
      calls.set.push([uid, agents]);
      return o.set ? await o.set(agents) : (agents as BusAddress[]);
    },
  };
  return { deps, calls };
}

const appWith = (deps: BusPageDeps) =>
  createApp((app) => mountBusPage(app, deps));

const get = (
  deps: BusPageDeps,
  path: string,
  cookie: string | null,
  e: Partial<Env> = {},
  headers: Record<string, string> = {},
) =>
  fetchAndWait(
    appWith(deps),
    new Request(`${APP}${path}`, {
      headers: { ...(cookie ? { cookie } : {}), ...headers },
    }),
    { ...env, ...e },
  );

const post = (
  deps: BusPageDeps,
  path: string,
  cookie: string | null,
  fields: [string, string][],
  o: { headers?: Record<string, string>; env?: Partial<Env> } = {},
) => {
  const body = new URLSearchParams(fields).toString();
  return fetchAndWait(
    appWith(deps),
    new Request(`${APP}${path}`, {
      method: "POST",
      headers: {
        ...(cookie ? { cookie } : {}),
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(body.length),
        ...o.headers,
      },
      body,
    }),
    { ...env, ...o.env },
  );
};

const shareToken = (uid: string) =>
  formCsrf(env, "bus-share-notices", uid, "share-notices");
const revokeToken = (uid: string, id: string) =>
  formCsrf(env, "bus-revoke", uid, id);
const SHARE = "/bus/share-notices";
const revokeUrl = (id: string) => `/bus/machines/${id}/revoke`;
const loc = (r: Response) => r.headers.get("location");

describe("bus page templates", () => {
  it("the emitted templates match Design's files (run `pnpm build` when stale)", () => {
    expect(BUS_PAGE_TEMPLATE).toBe(stripTemplateComment(designPage));
    expect(BUS_REVOKE_TEMPLATE).toBe(stripTemplateComment(designRevoke));
    const fromDesign = Object.fromEntries(
      Object.entries(designSnippets).map(([p, s]) => [
        p.slice(p.lastIndexOf("/") + 1, -5),
        busSnippetOf(s),
      ]),
    );
    expect(Object.keys(fromDesign).length).toBeGreaterThan(0);
    expect(BUS_SNIPPETS).toEqual(fromDesign);
  });

  it("renderTemplate escapes strings, keeps html results, and throws on a gap", () => {
    const t = "<p>{{a}}</p><!-- block:x --><i>{{b}}</i><!-- /block:x -->";
    expect(renderTemplate(t, { a: "<b>" }).value).toBe("<p>&lt;b&gt;</p>");
    expect(() => renderTemplate(t, {}, [])).toThrow(/\{\{a\}\}/);
    expect(() => renderTemplate(t, { a: "" }, ["x"])).toThrow(/\{\{b\}\}/);
    expect(() => renderTemplate(t, { a: "" }, ["nope"])).toThrow(/nope/);
  });

  it("times carry UTC and 'today' is the UTC day; dates are bare", () => {
    const now = new Date("2026-11-04T23:30:00Z");
    expect(lastUsedOf("2026-11-04T00:10:00Z", now)).toBe(
      "today at 12:10 AM UTC",
    );
    expect(lastUsedOf("2026-11-03T23:59:00Z", now)).toBe(
      "Nov 3 at 11:59 PM UTC",
    );
    expect(lastUsedOf(null, now)).toBe("Never");
    expect(dayOf("2026-10-21T23:59:00Z", now)).toBe("Oct 21");
    expect(dayOf("2025-10-21T12:00:00Z", now)).toBe("Oct 21, 2025");
  });

  it("addresses round trip and anything else decodes to null", () => {
    const a = { namespace: "leo-work", name: "clé" };
    expect(decodeAddress(encodeAddress(a))).toEqual(a);
    for (const bad of ["", "!!", btoa('["only"]'), btoa("{}"), btoa("[1,2]")])
      expect(decodeAddress(bad)).toBeNull();
  });
});

describe("GET /bus: who loads it", () => {
  it("no session: 302 to sign-in with next, and no hub read", async () => {
    const { deps, calls } = doubles();
    const r = await get(deps, "/bus?done=saved", null);
    expect(r.status).toBe(302);
    expect(loc(r)).toBe(
      `/auth/login?next=${encodeURIComponent("/bus?done=saved")}`,
    );
    expect(calls.busView).toEqual([]);
  });

  it("a Bearer token: 401, even for a member", async () => {
    const m = await login(email("tok"), "member");
    const { token } = await createPat(env, m.userId, "t");
    const { deps, calls } = doubles({ view: { machines: [machine()] } });
    const r = await get(
      deps,
      "/bus",
      null,
      {},
      { authorization: `Bearer ${token}` },
    );
    expect(r.status).toBe(401);
    expect(calls.busView).toEqual([]);
  });

  it("a guest with no unrevoked machine: 404", async () => {
    const g = await login(email("guest"), "guest");
    const { deps } = doubles({
      view: { machines: [machine({ revokedAt: "2026-10-30T00:00:00Z" })] },
    });
    expect((await get(deps, "/bus", g.cookie)).status).toBe(404);
  });

  it("a capped caller with an unrevoked machine: revoke-only, no share notices", async () => {
    const g = await login(email("capped"), "guest");
    const { deps, calls } = doubles({ view: { machines: [machine()] } });
    const r = await get(deps, "/bus", g.cookie);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain(
      "You can't connect new machines. You can revoke these.",
    );
    expect(body).toContain("Revoke");
    expect(body).not.toContain("Share notices");
    expect(calls.get).toEqual([]);
  });

  it("a member with no machines: the empty state and the no-agents share card", async () => {
    const m = await login(email("empty"), "member");
    const { deps } = doubles();
    const body = await (await get(deps, "/bus", m.cookie)).text();
    expect(body).toContain("No machines yet");
    expect(body).not.toContain("<table>");
    expect(body).toContain("Agents show up here while a session is running");
    expect(body).not.toContain("You can't connect new machines");
  });

  it("HOSTED=1: every /bus route is 404 and nothing is read", async () => {
    const m = await login(email("hosted"), "member");
    const { deps, calls } = doubles({ view: { machines: [machine()] } });
    const H = { HOSTED: "1" };
    expect((await get(deps, "/bus", m.cookie, H)).status).toBe(404);
    expect((await get(deps, revokeUrl("m1"), m.cookie, H)).status).toBe(404);
    const t = await revokeToken(m.userId, "m1");
    expect(
      (await post(deps, revokeUrl("m1"), m.cookie, [["csrf", t]], { env: H }))
        .status,
    ).toBe(404);
    const s = await shareToken(m.userId);
    expect(
      (await post(deps, SHARE, m.cookie, [["csrf", s]], { env: H })).status,
    ).toBe(404);
    expect(calls).toEqual({
      busView: [],
      machine: [],
      revoke: [],
      get: [],
      set: [],
    });
  });
});

describe("GET /bus: the page", () => {
  it("sets the page CSP, no-store and DENY, and fills every placeholder", async () => {
    const m = await login(email("hdr"), "member");
    const { deps } = doubles({ view: { machines: [machine()] } });
    const r = await get(deps, "/bus", m.cookie);
    expect(r.headers.get("content-security-policy")).toBe(PAGE_CSP);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    const body = await r.text();
    expect(body).not.toContain("{{");
    expect(body).not.toContain("block:");
  });

  it("escapes a label, agent name and namespace with <script> and quotes", async () => {
    const m = await login(email("esc"), "member");
    const evil = `"'><script>alert(1)</script>`;
    const { deps } = doubles({
      view: {
        machines: [machine({ label: evil })],
        agents: [agent({ name: evil, namespace: evil, machineLabel: evil })],
      },
      picked: [{ namespace: evil, name: "gone" }],
    });
    const body = await (await get(deps, "/bus", m.cookie)).text();
    expect(body).not.toContain("<script>");
    expect(body).not.toContain(`"'>`);
    expect(body).toContain(
      "&quot;&#39;&gt;&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  it("rows: Live, Offline, Unknown (connected null) and Revoked, with the live count", async () => {
    const m = await login(email("rows"), "member");
    const { deps } = doubles({
      view: {
        machines: [
          machine({ label: "lap", connected: true }),
          machine({ label: "box", connected: false, lastUsedAt: null }),
          machine({ label: "odd", connected: null }),
          machine({
            label: "old",
            revokedAt: "2026-10-30T12:00:00Z",
            connected: null,
          }),
        ],
      },
    });
    const body = await (await get(deps, "/bus", m.cookie)).text();
    expect(body).toContain("4 machines · 1 live");
    expect(body).toMatch(/s-live"><span class="dot"><\/span>Live/);
    expect(body).toMatch(/s-offline"><span class="dot"><\/span>Offline/);
    expect(body).toMatch(/s-unknown"><span class="dot"><\/span>Unknown/);
    expect(body).toContain("Revoked Oct 30");
    expect(body).toContain("Added </span>Oct 25");
    expect(body).toContain("Last used </span>Never");
    expect(body).toContain("Last used </span>Nov 2 at 6:10 PM UTC");
    // Revoked rows have no Revoke link.
    expect(body.match(/class="pill"/g)?.length).toBe(3);
    expect(body).not.toContain("Live status isn't available");
  });

  it("the picker: running agents as checkboxes, picked ones checked, picked-but-gone rows", async () => {
    const m = await login(email("pick"), "member");
    const claude = agent({ name: "claude" });
    const codex = agent({ name: "codex", machineLabel: "build-box" });
    const quiet = agent({ name: "sleeper", running: false });
    const gone = { namespace: "leo-work", name: "planner" };
    const { deps } = doubles({
      view: { machines: [machine()], agents: [claude, codex, quiet] },
      picked: [{ namespace: "leo-work", name: "claude" }, gone],
    });
    const body = await (await get(deps, "/bus", m.cookie)).text();
    expect(body).toContain(`value="${encodeAddress(claude)}" checked>`);
    expect(body).toContain(`value="${encodeAddress(codex)}" >`);
    expect(body).not.toContain("sleeper");
    expect(body).toContain("· leo-work · not running");
    expect(body).toContain(`name="remove" value="${encodeAddress(gone)}"`);
    expect(body).toContain(
      `form="share-save" name="address" value="${encodeAddress(gone)}"`,
    );
    expect(body).toContain(">Save</button>");
  });

  it("hub unknown: Unknown rows, no live count, the hub line, picked rows with Remove only", async () => {
    const m = await login(email("hub"), "member");
    const picked = { namespace: "leo-work", name: "claude" };
    const { deps } = doubles({
      view: {
        live: false,
        machines: [
          // A stale connected value still reads Unknown while the hub is unknown.
          machine({ connected: true }),
          machine({ connected: false }),
          machine({ revokedAt: "2026-10-30T00:00:00Z", connected: null }),
        ],
      },
      picked: [picked],
    });
    const body = await (await get(deps, "/bus", m.cookie)).text();
    expect(body).toContain(
      "Live status isn't available right now. Reload to try again.",
    );
    expect(body).toContain(">3 machines<");
    expect(body.match(/>Unknown</g)?.length).toBe(2);
    expect(body).not.toMatch(/>(Live|Offline)<\/span>/);
    expect(body).toContain("Running agents can't be listed right now");
    expect(body).toContain(`name="remove" value="${encodeAddress(picked)}"`);
    expect(body).not.toContain('type="checkbox"');
    expect(body).not.toContain(">Save</button>");
  });

  it("shows the done and error lines from the redirect; an unknown code shows nothing", async () => {
    const m = await login(email("msg"), "member");
    const mm = machine({ id: "mx", label: "<b>box</b>" });
    const { deps } = doubles({ view: { machines: [mm] } });
    const text = async (q: string) =>
      (await get(deps, `/bus?${q}`, m.cookie)).text();
    expect(await text("done=revoked&m=mx")).toContain(
      "&lt;b&gt;box&lt;/b&gt; revoked.",
    );
    expect(await text("done=saved")).toContain("Share notices saved.");
    expect(await text("error=too_many")).toContain(
      "You can pick up to 10 agents. Remove one, then save.",
    );
    expect(await text("error=expired")).toContain(
      "This page expired. Reload it and try again.",
    );
    expect(await text("error=not_allowed")).toContain(
      "You can&#39;t change share notices. You can still revoke machines here.",
    );
    expect(await text("error=failed")).toContain(
      "Something went wrong and nothing changed. Try again in a minute.",
    );
    expect(await text("error=__proto__")).not.toContain('class="msg');
  });
});

describe("revoke", () => {
  it("the confirm page names the machine (escaped) and posts a revoke token", async () => {
    const m = await login(email("conf"), "member");
    const mm = machine({ id: "mc", label: `"x"<i>` });
    const { deps } = doubles({ view: { machines: [mm] } });
    const r = await get(deps, revokeUrl("mc"), m.cookie);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toBe(PAGE_CSP);
    const body = await r.text();
    expect(body).toContain('<h1>Revoke "&quot;x&quot;&lt;i&gt;"?</h1>');
    expect(body).toContain('action="/bus/machines/mc/revoke"');
    expect(body).not.toContain("{{");
  });

  it("the confirm page for an unknown machine goes back with not_found", async () => {
    const m = await login(email("conf404"), "member");
    const { deps } = doubles({ view: { machines: [machine()] } });
    const r = await get(deps, revokeUrl("nope"), m.cookie);
    expect(r.status).toBe(303);
    expect(loc(r)).toBe("/bus?error=not_found");
  });

  it("POST revokes and redirects to done=revoked", async () => {
    const m = await login(email("rev"), "member");
    const { deps, calls } = doubles();
    const t = await revokeToken(m.userId, "m9");
    const r = await post(deps, revokeUrl("m9"), m.cookie, [["csrf", t]]);
    expect(r.status).toBe(303);
    expect(loc(r)).toBe("/bus?done=revoked&m=m9");
    expect(calls.revoke).toEqual([[m.userId, "m9"]]);
  });

  it("revoke false (unknown or another member's): not_found", async () => {
    const m = await login(email("revf"), "member");
    const { deps } = doubles({ revoke: async () => false });
    const t = await revokeToken(m.userId, "theirs");
    const r = await post(deps, revokeUrl("theirs"), m.cookie, [["csrf", t]]);
    expect(loc(r)).toBe("/bus?error=not_found");
  });

  it("revoke throwing internal (sockets didn't close): the partial line links back to its confirm page; anything else: failed", async () => {
    const m = await login(email("revt"), "member");
    const t = await revokeToken(m.userId, "m1");
    const revoked = machine({
      id: "m1",
      label: "<b>box</b>",
      revokedAt: "2026-11-04T09:00:00Z",
    });
    const internal = doubles({
      view: { machines: [revoked] },
      revoke: async () => {
        throw new ApiError("internal", "close failed");
      },
    });
    const r1 = await post(internal.deps, revokeUrl("m1"), m.cookie, [
      ["csrf", t],
    ]);
    expect(loc(r1)).toBe("/bus?error=revoke_failed&m=m1");
    const body = await (
      await get(internal.deps, loc(r1) ?? "", m.cookie)
    ).text();
    expect(body).toContain(
      `<span>&lt;b&gt;box&lt;/b&gt; is revoked and can't reconnect, but its open connection didn't close. <a class="link" href="/bus/machines/m1/revoke">Try again</a> to close it.</span>`,
    );
    expect(body).toContain('class="msg err"');
    // Without a machine of the caller's own to name, it's the generic line.
    const gone = await get(
      internal.deps,
      "/bus?error=revoke_failed&m=zz",
      m.cookie,
    );
    const goneBody = await gone.text();
    expect(goneBody).not.toContain("Try again</a>");
    expect(goneBody).toContain("Something went wrong and nothing changed.");
    const other = doubles({
      revoke: async () => {
        throw new Error("boom");
      },
    });
    const r2 = await post(other.deps, revokeUrl("m1"), m.cookie, [["csrf", t]]);
    expect(loc(r2)).toBe("/bus?error=failed");
  });

  it("retry: the confirm page loads for an own, already-revoked machine; its POST revokes again and shows the revoked line", async () => {
    const m = await login(email("retry"), "member");
    const revoked = machine({
      id: "m7",
      label: "build-box",
      revokedAt: "2026-11-04T09:00:00Z",
    });
    const { deps, calls } = doubles({ view: { machines: [revoked] } });
    const page = await get(deps, revokeUrl("m7"), m.cookie);
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain('<h1>Revoke "build-box"?</h1>');
    const csrf = /name="csrf" value="([^"]+)"/.exec(body)?.[1] ?? "";
    expect(csrf).not.toBe("");
    const r = await post(deps, revokeUrl("m7"), m.cookie, [["csrf", csrf]]);
    expect(loc(r)).toBe("/bus?done=revoked&m=m7");
    expect(calls.revoke).toEqual([[m.userId, "m7"]]);
    const after = await (await get(deps, loc(r) ?? "", m.cookie)).text();
    expect(after).toContain("build-box revoked.");
    expect(after).toContain('class="msg ok"');
  });

  it("a revoke-only caller can revoke; a guest without machines gets 404", async () => {
    const g = await login(email("revg"), "guest");
    const t = await revokeToken(g.userId, "m1");
    const has = doubles({ view: { machines: [machine({ id: "m1" })] } });
    const r = await post(has.deps, revokeUrl("m1"), g.cookie, [["csrf", t]]);
    expect(loc(r)).toBe("/bus?done=revoked&m=m1");
    const none = doubles();
    const r2 = await post(none.deps, revokeUrl("m1"), g.cookie, [["csrf", t]]);
    expect(r2.status).toBe(404);
    expect(none.calls.revoke).toEqual([]);
  });

  it("a capped caller whose only machine is revoked: confirm and POST work for theirs, 404 for another id", async () => {
    const g = await login(email("capret"), "guest");
    const mine = machine({
      id: "mine",
      label: "old-laptop",
      revokedAt: "2026-11-04T09:00:00Z",
    });
    const { deps, calls } = doubles({ view: { machines: [mine] } });
    // /bus itself hides with nothing to revoke...
    expect((await get(deps, "/bus", g.cookie)).status).toBe(404);
    // ...but the confirm page and its POST work for their own machine.
    const page = await get(deps, revokeUrl("mine"), g.cookie);
    expect(page.status).toBe(200);
    const csrf =
      /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    const r = await post(deps, revokeUrl("mine"), g.cookie, [["csrf", csrf]]);
    expect(loc(r)).toBe("/bus?done=revoked&m=mine");
    expect(calls.revoke).toEqual([[g.userId, "mine"]]);
    // Another member's (or an unknown) id: 404 on both, no revoke.
    expect((await get(deps, revokeUrl("theirs"), g.cookie)).status).toBe(404);
    const t = await revokeToken(g.userId, "theirs");
    const r2 = await post(deps, revokeUrl("theirs"), g.cookie, [["csrf", t]]);
    expect(r2.status).toBe(404);
    expect(calls.revoke).toEqual([[g.userId, "mine"]]);
  });

  it("a capped caller after a partial revoke of their last machine sees the retry line, not 404", async () => {
    const g = await login(email("capline"), "guest");
    const mine = machine({
      id: "mine",
      label: "old-laptop",
      revokedAt: "2026-11-04T09:00:00Z",
    });
    const internal = doubles({
      view: { machines: [mine] },
      revoke: async () => {
        throw new ApiError("internal", "close failed");
      },
    });
    const t = await revokeToken(g.userId, "mine");
    const r = await post(internal.deps, revokeUrl("mine"), g.cookie, [
      ["csrf", t],
    ]);
    expect(loc(r)).toBe("/bus?error=revoke_failed&m=mine");
    const page = await get(internal.deps, loc(r) ?? "", g.cookie);
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain(
      '<a class="link" href="/bus/machines/mine/revoke">Try again</a>',
    );
    expect(body).toContain(
      "You can't connect new machines. You can revoke these.",
    );
    expect(body).not.toContain("Share notices");
    // Not for another machine's id, nor without the error.
    expect(
      (await get(internal.deps, "/bus?error=revoke_failed&m=theirs", g.cookie))
        .status,
    ).toBe(404);
    expect(
      (await get(internal.deps, "/bus?error=failed&m=mine", g.cookie)).status,
    ).toBe(404);
  });

  it("a capped caller's successful retry shows the revoked line, not 404; another id or no params is 404", async () => {
    const g = await login(email("capdone"), "guest");
    const mine = machine({
      id: "mine",
      label: "old-laptop",
      revokedAt: "2026-11-04T09:00:00Z",
    });
    const { deps } = doubles({ view: { machines: [mine] } });
    const t = await revokeToken(g.userId, "mine");
    const r = await post(deps, revokeUrl("mine"), g.cookie, [["csrf", t]]);
    expect(loc(r)).toBe("/bus?done=revoked&m=mine");
    const page = await get(deps, loc(r) ?? "", g.cookie);
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain("old-laptop revoked.");
    expect(body).toContain(
      "You can't connect new machines. You can revoke these.",
    );
    expect(body).not.toContain("Share notices");
    for (const q of [
      "/bus?done=revoked&m=theirs",
      "/bus?done=saved&m=mine",
      "/bus",
    ])
      expect((await get(deps, q, g.cookie)).status).toBe(404);
  });
});

describe("share notices", () => {
  const a1 = { namespace: "leo-work", name: "claude" };
  const a2 = { namespace: "ops", name: "reviewer" };

  it("Save replaces the set with the checked and kept addresses, deduped", async () => {
    const m = await login(email("save"), "member");
    const { deps, calls } = doubles();
    const t = await shareToken(m.userId);
    const r = await post(deps, SHARE, m.cookie, [
      ["csrf", t],
      ["address", encodeAddress(a1)],
      ["address", encodeAddress(a2)],
      ["address", encodeAddress(a1)],
    ]);
    expect(loc(r)).toBe("/bus?done=saved");
    expect(calls.set).toEqual([[m.userId, [a1, a2]]]);
  });

  it("Save with nothing checked clears the set", async () => {
    const m = await login(email("clear"), "member");
    const { deps, calls } = doubles();
    const t = await shareToken(m.userId);
    await post(deps, SHARE, m.cookie, [["csrf", t]]);
    expect(calls.set).toEqual([[m.userId, []]]);
  });

  it("Remove posts the stored set minus that one", async () => {
    const m = await login(email("rm"), "member");
    const { deps, calls } = doubles({ picked: [a1, a2] });
    const t = await shareToken(m.userId);
    const r = await post(deps, SHARE, m.cookie, [
      ["csrf", t],
      ["remove", encodeAddress(a1)],
    ]);
    expect(loc(r)).toBe("/bus?done=saved");
    expect(calls.set).toEqual([[m.userId, [a2]]]);
  });

  it("a bad encoded address: bad_form, nothing set", async () => {
    const m = await login(email("bad"), "member");
    const { deps, calls } = doubles({ picked: [a1] });
    const t = await shareToken(m.userId);
    for (const f of [
      ["address", "!!"],
      ["address", btoa("[1]")],
      ["remove", "!!"],
    ] as [string, string][]) {
      const r = await post(deps, SHARE, m.cookie, [["csrf", t], f]);
      expect(loc(r)).toBe("/bus?error=bad_form");
    }
    expect(calls.set).toEqual([]);
  });

  it("over the cap: too_many; invalid or reserved: bad_form; anything else: failed", async () => {
    const m = await login(email("cap"), "member");
    const t = await shareToken(m.userId);
    const refusing = (e: unknown) =>
      doubles({
        set: async () => {
          throw e;
        },
      }).deps;
    const reason = (r: string) =>
      new ApiError("bad_request", "x", { path: "agents", reason: r });
    const fields: [string, string][] = [
      ["csrf", t],
      ["address", encodeAddress(a1)],
    ];
    expect(
      loc(await post(refusing(reason("too_many")), SHARE, m.cookie, fields)),
    ).toBe("/bus?error=too_many");
    expect(
      loc(await post(refusing(reason("invalid")), SHARE, m.cookie, fields)),
    ).toBe("/bus?error=bad_form");
    expect(
      loc(await post(refusing(reason("reserved")), SHARE, m.cookie, fields)),
    ).toBe("/bus?error=bad_form");
    expect(
      loc(await post(refusing(new Error("d1")), SHARE, m.cookie, fields)),
    ).toBe("/bus?error=failed");
  });

  it("a revoke-only caller gets not_allowed; a guest with nothing gets 404; neither writes", async () => {
    const g = await login(email("sg"), "guest");
    const t = await shareToken(g.userId);
    const fields: [string, string][] = [
      ["csrf", t],
      ["address", encodeAddress(a1)],
    ];
    const has = doubles({ view: { machines: [machine()] } });
    expect(loc(await post(has.deps, SHARE, g.cookie, fields))).toBe(
      "/bus?error=not_allowed",
    );
    const none = doubles();
    expect((await post(none.deps, SHARE, g.cookie, fields)).status).toBe(404);
    expect([...has.calls.set, ...none.calls.set]).toEqual([]);
  });

  it("a read failure on a capped caller's POST answers the HTML failure page, not the JSON API error", async () => {
    const g = await login(email("sf"), "guest");
    const { deps, calls } = doubles({ readFails: true });
    const html = async (r: Response) => {
      expect(r.status).toBe(500);
      expect(r.headers.get("content-type")).toMatch(/^text\/html/);
      expect(await r.text()).toContain("Something went wrong");
    };
    await html(
      await post(deps, SHARE, g.cookie, [
        ["csrf", await shareToken(g.userId)],
        ["address", encodeAddress(a1)],
      ]),
    );
    await html(
      await post(deps, revokeUrl("m1"), g.cookie, [
        ["csrf", await revokeToken(g.userId, "m1")],
      ]),
    );
    expect(calls.busView.length + calls.machine.length).toBe(2);
    expect([...calls.set, ...calls.revoke]).toEqual([]);
  });
});

describe("every POST: cross-site, size, CSRF", () => {
  const cases = [
    { path: SHARE, scope: "bus-share-notices", handle: "share-notices" },
    { path: revokeUrl("m1"), scope: "bus-revoke", handle: "m1" },
  ];
  for (const { path, scope, handle } of cases) {
    it(`${path}: missing, malformed, expired, another user's or another scope's token: expired, no write`, async () => {
      const m = await login(email("csrf"), "member");
      const other = await login(email("csrf-o"), "member");
      const good = await formCsrf(env, scope, m.userId, handle);
      const otherScope =
        scope === "bus-revoke" ? "bus-share-notices" : "bus-revoke";
      const tokens: (string | null)[] = [
        null,
        "1.x",
        `${Math.floor(Date.now() / 1000) - 1}${good.slice(good.indexOf("."))}`,
        await formCsrf(env, scope, other.userId, handle),
        await formCsrf(env, otherScope, m.userId, handle),
        await formCsrf(env, scope, m.userId, "m2"),
      ];
      const { deps, calls } = doubles({ view: { machines: [machine()] } });
      for (const t of tokens) {
        const r = await post(
          deps,
          path,
          m.cookie,
          t === null ? [] : [["csrf", t]],
        );
        expect(r.status).toBe(303);
        expect(loc(r)).toBe("/bus?error=expired");
      }
      expect(calls.revoke).toEqual([]);
      expect(calls.set).toEqual([]);
      // The good token goes through: the cases above failed on CSRF alone.
      const ok = await post(deps, path, m.cookie, [["csrf", good]]);
      expect(loc(ok)).toMatch(/done=/);
    });

    it(`${path}: cross-site 403, oversized body 400, Bearer 401, signed out 401; no write`, async () => {
      const m = await login(email("xs"), "member");
      const good = await formCsrf(env, scope, m.userId, handle);
      const { deps, calls } = doubles();
      const f: [string, string][] = [["csrf", good]];
      expect(
        (
          await post(deps, path, m.cookie, f, {
            headers: { "sec-fetch-site": "cross-site" },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await post(deps, path, m.cookie, [
            ...f,
            ["pad", "x".repeat(17 * 1024)],
          ])
        ).status,
      ).toBe(400);
      const { token } = await createPat(env, m.userId, "t");
      expect(
        (
          await post(deps, path, null, f, {
            headers: { authorization: `Bearer ${token}` },
          })
        ).status,
      ).toBe(401);
      expect((await post(deps, path, null, f)).status).toBe(401);
      // A chunked body (no content-length) fails closed before it's read.
      const chunked = await fetchAndWait(
        appWith(deps),
        new Request(`${APP}${path}`, {
          method: "POST",
          headers: {
            cookie: m.cookie,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new ReadableStream({
            start(ctl) {
              ctl.enqueue(
                new TextEncoder().encode(`csrf=${encodeURIComponent(good)}`),
              );
              ctl.close();
            },
          }),
          duplex: "half",
        } as RequestInit),
        env,
      );
      expect(chunked.status).toBe(400);
      expect(calls.revoke).toEqual([]);
      expect(calls.set).toEqual([]);
    });
  }
});
