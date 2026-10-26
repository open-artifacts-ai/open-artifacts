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
  PUBLIC_ROUTES,
  type Cred as ProbeCred,
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
// cross-install. Each read-only probe becomes a case through crossProbe;
// the case list is derived from those lists, so a surface Backend adds is a
// new case (and a required-case manifest entry) without a P5 change.

/** What the probes need on one install (seeded by `seedWorld`). */
export interface World {
  /** A private html artifact in a shared space the admin manages. */
  artifactId: string;
  /** The admin's private personal artifact (the side's marker). */
  personalId: string;
  org: OrgTarget;
  space: SpaceTarget;
}

export type Variant = "session" | "pat";

export interface ProbeCase {
  name: string;
  /** ROUTE_POLICY keys, `tool:<name>`, `content:<key>` this case reaches. */
  routes: readonly string[];
  /** Set: the case can't run cross-install; reported at this level, never pass. */
  skip?: ProofMeta;
  variant?: Variant;
  run?: (
    cred: ProbeCred,
    t: Target,
    w: World,
    fetch: ProbeFetch,
  ) => Promise<Verdict>;
}

/** The suite's caller on each install: hooks mint an org admin, never the owner. */
const CALLER = "orgAdmin" as const;

const MUTATES =
  "writes when allowed: skipped on live targets, as scripts/authz-probe.ts does";
const NOBODY =
  "no caller is allowed (personal-space rule): crossCheck has no success leg";
const NOT_ADMIN =
  "the org admin test user is not allowed (owner-only): hooks never mint the owner, so crossCheck has no success leg";

/**
 * The probe world's artifacts as expect.ts WORLD cells: the shared-space
 * artifact (the admin manages the space) and the admin's personal marker.
 */
const CELLS = [
  { who: "spaceManager", art: "spacePrivate", artifact: "artifactId" },
  { who: "personalOwner", art: "personalPrivate", artifact: "personalId" },
] as const;

/** Every probe as cases. Pure: derived from Backend's lists. */
export function probeCases(): ProbeCase[] {
  const out: ProbeCase[] = [];
  const variants = (cookieOnly: boolean): Variant[] =>
    cookieOnly ? ["session"] : ["session", "pat"];
  for (const s of SURFACES) {
    const name = `artifact ${s.name}`;
    if (s.mutates) {
      out.push({
        name,
        routes: s.routes,
        skip: {
          level: "not-applicable",
          reason: `${MUTATES} (mutates: ${s.mutates})`,
        },
      });
      continue;
    }
    if (s.action === "public.link") {
      out.push({
        name,
        routes: s.routes,
        skip: {
          level: "not-applicable",
          reason:
            "credential-free: /p/ serves public artifacts to anyone, so no tenant credential crosses",
        },
      });
      continue;
    }
    // The first world cell expect.ts allows (the admin test user stands in
    // for its caller there); none: no success leg.
    const cell = CELLS.find(
      (c) => expected(c.who, c.art, s.action, s.via) === "allow",
    );
    if (!cell) {
      out.push({
        name,
        routes: s.routes,
        skip: {
          level: "not-applicable",
          reason: `expect.ts allows no caller this action (${s.action}) on the probe world's artifacts: crossCheck has no success leg`,
        },
      });
      continue;
    }
    // MCP probes send the agent token only.
    const vs: Variant[] = s.via === "mcp" ? ["pat"] : variants(needsCookie(s));
    for (const v of vs)
      out.push({
        name: `${name} [${v}]`,
        routes: s.routes,
        variant: v,
        run: (cred, t, w, fetch) =>
          s.probe(t.app, cred, w[cell.artifact], {
            fetch,
            contentBase: t.content,
          }),
      });
  }
  for (const s of ORG_SURFACES) {
    const name = `org ${s.route}`;
    const skip: ProofMeta | undefined = s.mutates
      ? { level: "not-applicable", reason: `${MUTATES} (mutates: data)` }
      : orgExpected(CALLER, s.rule) === "deny"
        ? { level: "not-applicable", reason: NOT_ADMIN }
        : undefined;
    if (skip) {
      out.push({ name, routes: [s.route], skip });
      continue;
    }
    // Writes are probed by CSRF (a cookie); reads take either credential.
    for (const v of variants(!s.route.startsWith("GET ")))
      out.push({
        name: `${name} [${v}]`,
        routes: [s.route],
        variant: v,
        run: (cred, t, w, fetch) =>
          s.probe(t.app, cred, w.org, { fetch, contentBase: t.content }),
      });
  }
  for (const s of SPACE_SURFACES) {
    const name = `space ${s.name}`;
    const skip: ProofMeta | undefined = s.mutates
      ? { level: "not-applicable", reason: `${MUTATES} (mutates: access)` }
      : s.rule === "none"
        ? { level: "not-applicable", reason: NOBODY }
        : spaceExpected(CALLER, s.rule) === "deny"
          ? { level: "not-applicable", reason: NOT_ADMIN }
          : undefined;
    if (skip) {
      out.push({ name, routes: [s.route], skip });
      continue;
    }
    for (const v of variants(false))
      out.push({
        name: `${name} [${v}]`,
        routes: [s.route],
        variant: v,
        run: (cred, t, w, fetch) =>
          s.probe(t.app, cred, w.space, { fetch, contentBase: t.content }),
      });
  }
  return out;
}

/**
 * What the case list misses: a ROUTE_POLICY key no probe lists (or that is
 * not classified public), an artifact-scoped route or MCP tool no artifact
 * surface lists, a content route nobody probes, or a scoped route, tool or
 * content route that no case reaches. Empty when covered.
 */
export function coverageGaps(cases: readonly ProbeCase[] = probeCases()) {
  const reached = new Set(cases.flatMap((c) => c.routes));
  const scoped = Object.keys(ROUTE_POLICY).filter(
    (k) => !PUBLIC_ROUTES.includes(k),
  );
  const gaps = [
    ...unlisted(ROUTE_POLICY).map((k) => `unclassified route: ${k}`),
    ...uncovered(SURFACES, ROUTE_POLICY, TOOL_POLICY).map(
      (k) => `no artifact surface: ${k}`,
    ),
    ...contentUnlisted(Object.keys(CONTENT_POLICY)).map(
      (k) => `no content probe: ${k}`,
    ),
    ...scoped.filter((k) => !reached.has(k)).map((k) => `no case: ${k}`),
    ...Object.keys(TOOL_POLICY)
      .filter((t) => !reached.has(`tool:${t}`))
      .map((t) => `no case: tool:${t}`),
    ...Object.keys(CONTENT_POLICY)
      .filter((k) => !CONTENT_PUBLIC.includes(k))
      .filter((k) => !reached.has(`content:${k}`))
      .map((k) => `no case: content:${k}`),
  ];
  // The probe list is never shorter than the policy manifest it covers.
  if (cases.length < scoped.length + Object.keys(TOOL_POLICY).length)
    gaps.push(
      `${cases.length} cases < ${scoped.length} scoped routes + ${Object.keys(TOOL_POLICY).length} tools`,
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
          new Request(`${to.origin}${u.pathname}${u.search}`, req as RequestInit),
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

/**
 * Seeds what the probes need on `side`'s install (the WORLD of
 * apps/server/test/authz/expect.ts, for the admin test user): a shared
 * space, an html artifact in it (db, storage, viewer; title carries its id
 * and the side's marker; a thumbnail; doc "d" in collection "c"), and a
 * member (the org probes' member and departed target).
 */
export async function seedWorld(side: Side): Promise<World> {
  const { t, pat, marker } = side;
  const memberEmail = `redline-member@${t.testDomain}`;
  await sessionCred(t, memberEmail, "member");
  const members = (await api(t, pat, "GET", "/api/v1/members")) as {
    id: string;
    email: string;
  }[];
  const member = members.find((m) => m.email === memberEmail);
  if (!member) throw new Error(`${t.name}: the member test user is missing`);
  const space = (await api(t, pat, "POST", "/api/v1/spaces", {
    json: { name: `redline ${marker.slice(-12)}` },
  })) as { id?: string };
  if (typeof space.id !== "string") throw new Error(`${t.name}: no space id`);
  // A new space has no members: the admin joins it as manager to publish.
  await api(t, pat, "POST", `/api/v1/spaces/${space.id}/members/self`, {
    json: { role: "manager" },
  });
  const art = (await api(t, pat, "POST", "/api/v1/artifacts", {
    json: {
      title: marker,
      format: "html",
      content: `<p>${marker}</p>`,
      capabilities: { db: true, storage: true, viewer: true },
      visibility: "private",
      spaceId: space.id,
    },
  })) as { id?: string };
  const id = art.id;
  if (typeof id !== "string") throw new Error(`${t.name}: no artifact id`);
  const A = `/api/v1/artifacts/${id}`;
  // Search probes look the artifact up by id.
  await api(t, pat, "PATCH", A, { json: { title: `${marker} ${id}` } });
  await api(t, pat, "PUT", `${A}/thumbnail`, {
    raw: WEBP,
    type: "image/webp",
  });
  await api(t, pat, "PUT", `${A}/data/c/d`, { json: { v: 1 } });
  // "space delete (S)" is read-only only while S holds an artifact (409).
  const got = (await api(t, pat, "GET", A)) as { space?: { id?: unknown } };
  if (got.space?.id !== space.id)
    throw new Error(`${t.name}: the probe artifact is not in the space`);
  return {
    artifactId: id,
    personalId: side.markerId,
    org: { spaceId: space.id, memberId: member.id, departedId: member.id },
    space: {
      spaceId: space.id,
      // Only the space's own probes run cross-install; the rest are skipped.
      personalSpaceId: "",
      memberId: member.id,
      editorId: member.id,
      managerId: member.id,
      groups: { viewer: "", manager: "", free: "" },
    },
  };
}

/** Removes the probe artifact (the space keeps it in the trash). */
export async function cleanWorld(side: Side, w: World): Promise<void> {
  await fetch(
    `${side.t.app}/api/v1/artifacts/${encodeURIComponent(w.artifactId)}`,
    withCred(side.pat, { method: "DELETE" }),
  ).then((r) => r.body?.cancel());
}
