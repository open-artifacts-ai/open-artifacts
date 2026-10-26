import {
  CONTENT_POLICY,
  ROUTE_POLICY,
  TOOL_POLICY,
} from "../../../apps/server/src/auth/route-policy-table.ts";
import {
  expected,
  orgExpected,
  spaceExpected,
} from "../../../apps/server/test/authz/expect.ts";
import {
  CONTENT_PUBLIC,
  contentUnlisted,
  needsCookie,
  ORG_SURFACES,
  type OrgTarget,
  PROBE_SHARE_EMAIL,
  type Cred as ProbeCred,
  PUBLIC_ROUTES,
  SPACE_SURFACES,
  type SpaceTarget,
  SURFACES,
  uncovered,
  unlisted,
} from "../../../apps/server/test/authz/surfaces.ts";
import {
  adminEmail,
  type Cred,
  HttpError,
  parseJson,
  readBody,
  sessionCred,
  withCred,
} from "./http.ts";
import type { ProbeFetch, Side, Verdict } from "./refused.ts";
import type { ProofMeta } from "./report.ts";
import type { Target } from "./targets.ts";

// P5 Task 3b: Backend's surface probes (P3 T16, the same SURFACES,
// ORG_SURFACES and SPACE_SURFACES scripts/authz-probe.ts runs) driven
// cross-install. Read-only probes run through crossProbe on a seeded world;
// mutating probes through crossWrite on throwaways each install makes for
// itself. The case list is derived from those lists, so a surface Backend
// adds is a new case (and a required-case manifest entry) without a P5
// change. A surface that can't run cross-install is dropped only through
// DROPPED (an explicit, reasoned list the coverage check holds to the rule).

/** What the probes need on one install (seeded by `seedWorld`). */
export interface World {
  /** A private html artifact in a shared space the admin manages. */
  artifactId: string;
  /** The admin's private personal artifact (the side's marker). */
  personalId: string;
  /** The shared space holding `artifactId`. */
  spaceId: string;
  /** Plain member test users (the space probes' member, editor and peer manager). */
  users: { member: string; editor: string; manager: string };
  org: OrgTarget;
  space: SpaceTarget;
}

/** A throwaway a mutating probe writes to (made by the install's own admin). */
export type Fresh = "artifact-space" | "artifact-personal" | "space" | "org";
export interface Throwaway {
  fresh: Fresh;
  artifactId?: string;
  space?: SpaceTarget;
  org?: OrgTarget;
}

export type Variant = "session" | "pat";

export interface ProbeCase {
  name: string;
  /** ROUTE_POLICY keys, `tool:<name>`, `content:<key>` this case reaches. */
  routes: readonly string[];
  variant: Variant;
  /** Read-only: runs on the seeded world. */
  run?: (
    cred: ProbeCred,
    t: Target,
    w: World,
    fetch: ProbeFetch,
  ) => Promise<Verdict>;
  /** Mutating: runs on a fresh throwaway per leg (crossWrite). */
  write?: {
    fresh: Fresh;
    run: (
      cred: ProbeCred,
      t: Target,
      x: Throwaway,
      fetch: ProbeFetch,
    ) => Promise<Verdict>;
  };
}

/** The suite's caller on each install: hooks mint an org admin, never the owner. */
const CALLER = "orgAdmin" as const;

/**
 * The probe world's artifacts as expect.ts WORLD cells: the shared-space
 * artifact (the admin manages the space) and the admin's personal marker.
 */
const CELLS = [
  {
    who: "spaceManager",
    art: "spacePrivate",
    artifact: "artifactId",
    fresh: "artifact-space",
  },
  {
    who: "personalOwner",
    art: "personalPrivate",
    artifact: "personalId",
    fresh: "artifact-personal",
  },
] as const;

export type DropWhy =
  | "owner-only"
  | "nobody"
  | "no-world-caller"
  | "credential-free"
  | "no-directory";

/**
 * Routes whose success leg needs a connected Google directory: the
 * callback answers 404 without the connector, and a mapping delete needs a
 * mapping row only a connected directory can create. The red-line installs
 * have none.
 */
const NO_DIRECTORY = {
  org: ["GET /api/v1/directory/callback"],
  space: ["DELETE /api/v1/spaces/:id/mappings/:groupId"],
} as const satisfies Record<string, readonly string[]>;

/** Why a surface can't run cross-install: no success leg is possible. */
const WHY: Record<DropWhy, string> = {
  "owner-only":
    "owner-only: hooks never mint the owner and no owner credential is stored in CI, so crossCheck has no success leg",
  nobody:
    "no caller is allowed (personal-space rule), so crossCheck has no success leg",
  "no-world-caller":
    "expect.ts allows no caller this action on any artifact (anonymous writes only), so crossCheck has no success leg",
  "credential-free":
    "credential-free: /p/ serves public artifacts to anyone, so no tenant credential crosses",
  "no-directory":
    "needs a connected Google directory (the connector, or a mapping row only it creates); the red-line installs have none, so crossCheck has no success leg",
};

const MATRIX = "apps/server/test/authz.surface-matrix.test.ts";
const R4 =
  "live/credentials.test.ts (R4): A's admin PAT and session cookie are refused at B";
const BY_OWNER = `${MATRIX} "instance routes" (orgOwner allowed, everyone else refused) + ${R4}`;
const BY_DIRECTORY = `${MATRIX} "instance routes" and "space writes" (the fixture connects a directory) + ${R4}`;
const BY_PERSONAL = `${MATRIX} "space writes" and "attack seeds: another member's personal space" + ${R4}`;

/**
 * The surfaces dropped from the cross-install suite (P5 plan, Task 3b),
 * each with the tests that cover it instead. The coverage check fails
 * unless this matches exactly the surfaces the rules drop.
 */
export const DROPPED: Readonly<
  Record<string, { why: DropWhy; coveredBy: string }>
> = {
  "artifact anon id": {
    why: "no-world-caller",
    coveredBy: `${MATRIX} "artifact surfaces" (anonId: refused for every caller) + ${R4}`,
  },
  "artifact content /p/": {
    why: "credential-free",
    coveredBy: `${MATRIX} "artifact surfaces" (public.link) + R4 "A's signed content URL at B's content host"`,
  },
  "org GET /api/v1/directory/connect": {
    why: "owner-only",
    coveredBy: BY_OWNER,
  },
  "org POST /api/v1/directory/confirm": {
    why: "owner-only",
    coveredBy: BY_OWNER,
  },
  "org POST /api/v1/directory/cancel": {
    why: "owner-only",
    coveredBy: BY_OWNER,
  },
  "org POST /api/v1/directory/sync": { why: "owner-only", coveredBy: BY_OWNER },
  "org POST /api/v1/directory/held/:groupId/confirm": {
    why: "owner-only",
    coveredBy: BY_OWNER,
  },
  "org POST /api/v1/directory/disconnect": {
    why: "owner-only",
    coveredBy: `${BY_OWNER} + ${MATRIX} "directory disconnect: cookie sessions only"`,
  },
  "org DELETE /api/v1/directory": {
    why: "owner-only",
    coveredBy: `${BY_OWNER} + ${MATRIX} "directory disconnect: cookie sessions only"`,
  },
  "org GET /api/v1/directory/callback": {
    why: "no-directory",
    coveredBy: BY_DIRECTORY,
  },
  "space mapping delete viewer": {
    why: "no-directory",
    coveredBy: BY_DIRECTORY,
  },
  "space mapping delete a manager mapping": {
    why: "no-directory",
    coveredBy: BY_DIRECTORY,
  },
  "space patch {} (personal)": { why: "nobody", coveredBy: BY_PERSONAL },
  "space delete (personal)": { why: "nobody", coveredBy: BY_PERSONAL },
  "space member put (personal)": { why: "nobody", coveredBy: BY_PERSONAL },
  "space member delete (personal)": { why: "nobody", coveredBy: BY_PERSONAL },
  "space mapping put (personal)": { why: "nobody", coveredBy: BY_PERSONAL },
  "space mapping delete (personal)": { why: "nobody", coveredBy: BY_PERSONAL },
};

export interface Dropped {
  name: string;
  routes: readonly string[];
  why: DropWhy;
  reason: string;
}

export interface Derived {
  cases: ProbeCase[];
  dropped: Dropped[];
}

/** Every probe as cases or drops, by rule. Pure: derived from Backend's lists. */
export function derive(): Derived {
  const cases: ProbeCase[] = [];
  const dropped: Dropped[] = [];
  const drop = (name: string, routes: readonly string[], why: DropWhy) =>
    dropped.push({ name, routes, why, reason: WHY[why] });
  const variants = (cookieOnly: boolean): Variant[] =>
    cookieOnly ? ["session"] : ["session", "pat"];
  for (const s of SURFACES) {
    const name = `artifact ${s.name}`;
    if (s.action === "public.link") {
      drop(name, s.routes, "credential-free");
      continue;
    }
    // The first world cell expect.ts allows (the admin test user stands in
    // for its caller there); none: no success leg.
    const cell = CELLS.find(
      (c) => expected(c.who, c.art, s.action, s.via) === "allow",
    );
    if (!cell) {
      drop(name, s.routes, "no-world-caller");
      continue;
    }
    const io = (t: Target, fetch: ProbeFetch) => ({
      fetch,
      contentBase: t.content,
    });
    // MCP probes send the agent token only.
    for (const v of s.via === "mcp"
      ? (["pat"] as Variant[])
      : variants(needsCookie(s)))
      cases.push({
        name: `${name} [${v}]`,
        routes: s.routes,
        variant: v,
        ...(s.mutates
          ? {
              write: {
                fresh: cell.fresh,
                run: (cred, t, x, fetch) =>
                  s.probe(t.app, cred, need(x.artifactId), io(t, fetch)),
              },
            }
          : {
              run: (cred, t, w, fetch) =>
                s.probe(t.app, cred, w[cell.artifact], io(t, fetch)),
            }),
      });
  }
  for (const s of ORG_SURFACES) {
    const name = `org ${s.route}`;
    if (orgExpected(CALLER, s.rule) === "deny") {
      drop(name, [s.route], "owner-only");
      continue;
    }
    if ((NO_DIRECTORY.org as readonly string[]).includes(s.route)) {
      drop(name, [s.route], "no-directory");
      continue;
    }
    // Writes are probed by CSRF (a cookie); reads take either credential.
    for (const v of variants(!s.route.startsWith("GET ")))
      cases.push({
        name: `${name} [${v}]`,
        routes: [s.route],
        variant: v,
        ...(s.mutates
          ? {
              write: {
                fresh: "org" as const,
                run: (cred, t, x, fetch) =>
                  s.probe(t.app, cred, need(x.org), { fetch }),
              },
            }
          : {
              run: (cred, t, w, fetch) =>
                s.probe(t.app, cred, w.org, { fetch }),
            }),
      });
  }
  for (const s of SPACE_SURFACES) {
    const name = `space ${s.name}`;
    if (s.rule === "none") {
      drop(name, [s.route], "nobody");
      continue;
    }
    if (spaceExpected(CALLER, s.rule) === "deny") {
      drop(name, [s.route], "owner-only");
      continue;
    }
    if ((NO_DIRECTORY.space as readonly string[]).includes(s.route)) {
      drop(name, [s.route], "no-directory");
      continue;
    }
    for (const v of variants(false))
      cases.push({
        name: `${name} [${v}]`,
        routes: [s.route],
        variant: v,
        ...(s.mutates
          ? {
              write: {
                fresh: "space" as const,
                run: (cred, t, x, fetch) =>
                  s.probe(t.app, cred, need(x.space), { fetch }),
              },
            }
          : {
              run: (cred, t, w, fetch) =>
                s.probe(t.app, cred, w.space, { fetch }),
            }),
      });
  }
  return { cases, dropped };
}

function need<T>(v: T | undefined): T {
  if (v === undefined)
    throw new Error("the throwaway lacks what this probe needs");
  return v;
}

export const probeCases = (): ProbeCase[] => derive().cases;

/**
 * What the suite misses: a ROUTE_POLICY key no probe lists (or that is not
 * classified public), an artifact-scoped route or MCP tool no artifact
 * surface lists, a content route nobody probes, a scoped route, tool or
 * content route no case reaches and no recorded drop covers, a drop the
 * rules make that DROPPED doesn't record (or records differently), or a
 * case list shorter than the policy manifest. Empty when covered.
 */
export function coverageGaps(d: Derived = derive()): string[] {
  const { cases, dropped } = d;
  const recorded = dropped.filter((x) => DROPPED[x.name]?.why === x.why);
  const reached = new Set([
    ...cases.flatMap((c) => c.routes),
    ...recorded.flatMap((x) => x.routes),
  ]);
  const derivedNames = new Set(dropped.map((x) => x.name));
  const scoped = Object.keys(ROUTE_POLICY).filter(
    (k) => !PUBLIC_ROUTES.includes(k),
  );
  const tools = Object.keys(TOOL_POLICY);
  const gaps = [
    ...unlisted(ROUTE_POLICY).map((k) => `unclassified route: ${k}`),
    ...uncovered(SURFACES, ROUTE_POLICY, TOOL_POLICY).map(
      (k) => `no artifact surface: ${k}`,
    ),
    ...contentUnlisted(Object.keys(CONTENT_POLICY)).map(
      (k) => `no content probe: ${k}`,
    ),
    ...dropped
      .filter((x) => DROPPED[x.name]?.why !== x.why)
      .map((x) => `drop not recorded in DROPPED: ${x.name} (${x.why})`),
    ...Object.keys(DROPPED)
      .filter((n) => !derivedNames.has(n))
      .map((n) => `DROPPED lists a surface the rules don't drop: ${n}`),
    ...Object.entries(DROPPED)
      .filter(([, v]) => !v.coveredBy.trim())
      .map(([n]) => `drop without a covering test: ${n}`),
    ...scoped.filter((k) => !reached.has(k)).map((k) => `no case: ${k}`),
    ...tools
      .filter((t) => !reached.has(`tool:${t}`))
      .map((t) => `no case: tool:${t}`),
    ...Object.keys(CONTENT_POLICY)
      .filter((k) => !CONTENT_PUBLIC.includes(k))
      .filter((k) => !reached.has(`content:${k}`))
      .map((k) => `no case: content:${k}`),
  ];
  // The probe list is never shorter than the policy manifest it covers.
  const n = cases.length + recorded.length;
  if (n < scoped.length + tools.length)
    gaps.push(
      `${n} cases and drops < ${scoped.length} scoped routes + ${tools.length} tools`,
    );
  return gaps;
}

/**
 * Local mode: the server mints content URLs for its CONTENT_HOST without
 * wrangler's port; send them to the target's real origin. Loopback hosts
 * only, so a staging URL is never rewritten.
 */
export function viaTarget(t: Target, f: ProbeFetch): ProbeFetch {
  return (req) => {
    const u = new URL(req.url);
    for (const o of [t.app, t.content]) {
      const to = new URL(o);
      if (
        u.hostname === to.hostname &&
        u.hostname.endsWith(".localhost") &&
        u.origin !== to.origin
      )
        return f(
          new Request(
            `${to.origin}${u.pathname}${u.search}`,
            req as RequestInit,
          ),
        );
    }
    return f(req);
  };
}

/** The probe credentials for one side's admin test user. */
export function probeCred(side: Side, v: Variant): ProbeCred {
  const email = adminEmail(side.t);
  if (v === "session") {
    if (side.cookie.kind !== "cookie") throw new Error("no session cookie");
    return { cookie: `${side.cookie.name}=${side.cookie.value}`, email };
  }
  if (side.pat.kind !== "pat") throw new Error("no PAT");
  return { token: side.pat.token, email };
}

async function api(
  t: Target,
  pat: Cred,
  method: string,
  path: string,
  body?: { json: unknown } | { raw: Uint8Array<ArrayBuffer>; type: string },
  ok: number[] = [200, 201, 204],
): Promise<unknown> {
  const headers: Record<string, string> = {};
  let b: BodyInit | undefined;
  if (body && "json" in body) {
    headers["content-type"] = "application/json";
    b = JSON.stringify(body.json);
  } else if (body) {
    headers["content-type"] = body.type;
    b = body.raw;
  }
  const res = await fetch(
    `${t.app}${path}`,
    withCred(pat, { method, headers, body: b }),
  );
  const text = await readBody(res);
  const what = `${t.name} seed ${method} ${path.replace(/[A-Za-z0-9_-]{16,}/g, ":id")}`;
  if (!ok.includes(res.status)) throw new HttpError(what, res, text);
  return text ? parseJson(res, text, what) : null;
}

/** A minimal body that passes the server's WebP check (RIFF....WEBP). */
const WEBP = new Uint8Array([
  ...new TextEncoder().encode("RIFF"),
  4,
  0,
  0,
  0,
  ...new TextEncoder().encode("WEBP"),
]);

/** A member test user's id, created through the session hook when missing. */
async function memberId(t: Target, pat: Cred, who: string): Promise<string> {
  const email = `redline-${who}@${t.testDomain}`;
  await sessionCred(t, email, "member");
  const members = (await api(t, pat, "GET", "/api/v1/members")) as {
    id: string;
    email: string;
  }[];
  const m = members.find((x) => x.email === email);
  if (!m) throw new Error(`${t.name}: the ${who} test user is missing`);
  return m.id;
}

/** A shared space the admin manages (a new space has no members). */
async function newSpace(side: Side, label: string): Promise<string> {
  const { t, pat, marker } = side;
  const space = (await api(t, pat, "POST", "/api/v1/spaces", {
    json: { name: `redline ${label} ${marker.slice(-8)}` },
  })) as { id?: string };
  if (typeof space.id !== "string") throw new Error(`${t.name}: no space id`);
  await api(t, pat, "POST", `/api/v1/spaces/${space.id}/members/self`, {
    json: { role: "manager" },
  });
  return space.id;
}

/** A private html artifact (db, storage, viewer; doc "d" and "probe" in "c"). */
async function newArtifact(
  side: Side,
  title: string,
  spaceId?: string,
): Promise<string> {
  const { t, pat } = side;
  const art = (await api(t, pat, "POST", "/api/v1/artifacts", {
    json: {
      title,
      format: "html",
      content: `<p>${title}</p>`,
      capabilities: { db: true, storage: true, viewer: true },
      visibility: "private",
      ...(spaceId ? { spaceId } : {}),
    },
  })) as { id?: string };
  if (typeof art.id !== "string") throw new Error(`${t.name}: no artifact id`);
  const A = `/api/v1/artifacts/${art.id}`;
  await api(t, pat, "PUT", `${A}/data/c/d`, { json: { v: 1 } });
  await api(t, pat, "PUT", `${A}/data/c/probe`, { json: { p: 0 } });
  return art.id;
}

/**
 * Seeds what the probes need on `side`'s install (the WORLD of
 * apps/server/test/authz/expect.ts, for the admin test user): a shared
 * space, an html artifact in it (title carries its id and the side's
 * marker; a thumbnail; doc "d" in collection "c"), and member test users
 * (the org probes' member and departed target, the space probes' member,
 * editor and peer manager).
 */
export async function seedWorld(side: Side): Promise<World> {
  const { t, pat, marker } = side;
  const users = {
    member: await memberId(t, pat, "member"),
    editor: await memberId(t, pat, "editor"),
    manager: await memberId(t, pat, "manager"),
  };
  const spaceId = await newSpace(side, "world");
  const id = await newArtifact(side, marker, spaceId);
  const A = `/api/v1/artifacts/${id}`;
  // Search probes look the artifact up by id.
  await api(t, pat, "PATCH", A, { json: { title: `${marker} ${id}` } });
  await api(t, pat, "PUT", `${A}/thumbnail`, {
    raw: WEBP,
    type: "image/webp",
  });
  // "space delete (S)" is read-only only while S holds an artifact (409).
  const got = (await api(t, pat, "GET", A)) as { space?: { id?: unknown } };
  if (got.space?.id !== spaceId)
    throw new Error(`${t.name}: the probe artifact is not in the space`);
  return {
    artifactId: id,
    personalId: side.markerId,
    spaceId,
    users,
    org: { spaceId, memberId: users.member, departedId: users.member },
    space: spaceTarget(spaceId, users),
  };
}

const spaceTarget = (
  spaceId: string,
  u: World["users"],
  cloneId?: string,
): SpaceTarget => ({
  spaceId,
  // The personal-space probes are dropped (DROPPED): nobody is allowed.
  personalSpaceId: "",
  memberId: u.member,
  editorId: u.editor,
  managerId: u.manager,
  // No directory on the red-line installs: the mapping probes answer the
  // service's 409 (sync off) past the access rule, an allowed answer.
  groups: {
    viewer: "redline-viewer",
    manager: "redline-manager",
    free: "redline-free",
  },
  ...(cloneId ? { cloneId } : {}),
});

/** Throwaways not yet disposed, per install (the afterAll sweep). */
const LIVE = new Map<Target, Set<Throwaway>>();

/** A throwaway on `side`'s own install, made with its own admin PAT. */
export async function throwaway(
  side: Side,
  w: World,
  fresh: Fresh,
): Promise<Throwaway> {
  const x: Throwaway = { fresh };
  const set = LIVE.get(side.t) ?? new Set<Throwaway>();
  LIVE.set(side.t, set);
  set.add(x);
  if (fresh === "org") x.org = w.org;
  else if (fresh === "space") {
    const clone = await newSpace(side, "throwaway");
    x.space = spaceTarget(w.spaceId, w.users, clone);
    const put = (id: string, role: string) =>
      api(side.t, side.pat, "PUT", `/api/v1/spaces/${clone}/members/${id}`, {
        json: { role },
      });
    await put(w.users.member, "viewer");
    await put(w.users.editor, "editor");
    await put(w.users.manager, "manager");
  } else {
    x.artifactId = await newArtifact(
      side,
      `redline throwaway ${side.marker.slice(-8)}`,
      fresh === "artifact-space" ? w.spaceId : undefined,
    );
    // The unshare probes remove this share (as the matrix seeds it).
    await api(
      side.t,
      side.pat,
      "PUT",
      `/api/v1/artifacts/${x.artifactId}/shares`,
      {
        json: { email: PROBE_SHARE_EMAIL, role: "viewer" },
      },
    );
  }
  return x;
}

/** Status and body of each GET, as B's own admin sees them. */
async function reads(side: Side, paths: string[]): Promise<string> {
  const out: string[] = [];
  for (const p of paths) {
    const r = await fetch(`${side.t.app}${p}`, withCred(side.pat));
    out.push(`${p} ${r.status} ${await readBody(r)}`);
  }
  return out.join("\n");
}

/**
 * What a write would change on a throwaway: the artifact (metadata, data,
 * shares, versions), the space (settings, members, mappings), or the
 * install's audit log (the org probes).
 */
export function snapshot(side: Side, x: Throwaway): Promise<string> {
  if (x.artifactId) {
    const A = `/api/v1/artifacts/${x.artifactId}`;
    return reads(side, [A, `${A}/data/c`, `${A}/shares`, `${A}/versions`]);
  }
  if (x.space?.cloneId) {
    const S = `/api/v1/spaces/${x.space.cloneId}`;
    return reads(side, [S, `${S}/members`, `${S}/mappings`]);
  }
  return reads(side, ["/api/v1/audit"]);
}

/** Deletes a throwaway (an artifact goes to the trash). Never throws. */
export async function dispose(side: Side, x: Throwaway): Promise<void> {
  LIVE.get(side.t)?.delete(x);
  const del = (p: string) =>
    fetch(`${side.t.app}${p}`, withCred(side.pat, { method: "DELETE" }))
      .then((r) => r.body?.cancel())
      .catch(() => {});
  if (x.artifactId) await del(`/api/v1/artifacts/${x.artifactId}`);
  if (x.space?.cloneId) await del(`/api/v1/spaces/${x.space.cloneId}`);
}

/** Disposes every throwaway still live on `side`'s install. */
export async function sweep(side: Side): Promise<void> {
  for (const x of [...(LIVE.get(side.t) ?? [])]) await dispose(side, x);
}

/** Removes the probe artifact (the space keeps it in the trash). */
export async function cleanWorld(side: Side, w: World): Promise<void> {
  await fetch(
    `${side.t.app}/api/v1/artifacts/${encodeURIComponent(w.artifactId)}`,
    withCred(side.pat, { method: "DELETE" }),
  ).then((r) => r.body?.cancel());
}
