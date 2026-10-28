import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import { authorizeCode, mcpResource, pkce, registerClient } from "./creds.ts";
import { InfraError, setupFetch } from "./fetch-timeout.ts";
import {
  adminEmail,
  type Cred,
  HttpError,
  hook,
  parseJson,
  readBody,
  sessionCred,
  withCred,
} from "./http.ts";
import type { ProbeFetch, Side, Verdict } from "./refused.ts";
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
  /** A deleted artifact in the world space, in the trash (R.trash's probe). */
  trashedId: string;
  /** The shared space holding `artifactId`. */
  spaceId: string;
  /** Plain member test users (the space probes' member, editor and peer manager). */
  users: { member: string; editor: string; manager: string };
  org: OrgTarget;
  space: SpaceTarget;
  /** GUARD_SPACE: the read-only space probes' target ("delete (S)" answers 409). */
  guard: SpaceTarget;
}

/** A throwaway a mutating probe writes to (made by the install's own admin). */
export type Fresh =
  | "artifact-space"
  | "artifact-personal"
  | "space"
  /** A token of the admin's (POST R.tokens, by session). */
  | "token"
  /** An OAuth grant of the admin's (the consent flow, by session). */
  | "grant";
export interface Throwaway {
  fresh: Fresh;
  artifactId?: string;
  space?: SpaceTarget;
  tokenId?: string;
  grantId?: string;
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
  // Last, so only what no live cell allows (the trash listing) lands here.
  {
    who: "spaceManager",
    art: "deletedSpace",
    artifact: "trashedId",
    fresh: "artifact-space",
  },
] as const;

export type DropWhy =
  | "real-only"
  | "owner-only"
  | "nobody"
  | "no-world-caller"
  | "credential-free"
  | "no-directory"
  | "feature-off";

/**
 * FEATURES every hosted install has (packages/provision/src/metadata.ts,
 * userWorkerMetadata: always `spaces,usage_off`); the local pair sets the same.
 */
export const HOSTED_FEATURES: readonly string[] = ["spaces", "usage_off"];

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
  "real-only":
    "real-only (#839): past the access rules the route either writes or answers a 404 that looks like a refusal, and its throwaway (a Google identity link, a directory group or a mapping) needs a connected Google directory, so crossCheck has no success leg",
  "owner-only":
    "owner-only: hooks never mint the owner and no owner credential is stored in CI, so crossCheck has no success leg",
  nobody:
    "no caller is allowed (personal-space rule), so crossCheck has no success leg",
  "no-world-caller":
    "expect.ts allows no caller this action on any artifact (anonymous writes only), so crossCheck has no success leg",
  "credential-free":
    "credential-free: /p/ serves public artifacts to anyone, so no tenant credential crosses",
  "feature-off":
    "hidden on hosted installs (a FEATURES flag every hosted install sets turns it off: 404 for everyone), so crossCheck has no success leg",
  "no-directory":
    "needs a connected Google directory (the connector, or a mapping row only it creates); the red-line installs have none, so crossCheck has no success leg",
};

/** A test that covers a dropped surface: a file, its describe, and a test in it. */
export interface Citation {
  /** Repo-relative path. */
  file: string;
  describe: string;
  test?: string;
}

const MATRIX = "apps/server/test/authz.surface-matrix.test.ts";
const FOREIGN = "apps/server/test/redline.foreign-credential.test.ts";
const FOREIGN_D =
  "red line: another install's credential on the dropped directory surfaces";
const INSTANCE: Citation = { file: MATRIX, describe: "instance routes" };
const ARTIFACTS: Citation = {
  file: MATRIX,
  describe: "artifact surfaces (sync stale 8 days)",
};
const BY_PERSONAL: Citation[] = [
  {
    file: MATRIX,
    describe: "space writes (the service rules behind { user })",
  },
  { file: MATRIX, describe: "attack seeds: another member's personal space" },
];
const DISCONNECT: Citation = {
  file: MATRIX,
  describe:
    "directory disconnect: cookie sessions only, plus the platform system job",
};

/**
 * Routes and tools no case reaches, each only through a recorded drop
 * (DROPPED), with why. The coverage check fails on any other unreached
 * route and on an exclusion a case now reaches.
 */
const OWNER_ONLY =
  "owner-only (the directory connection): no admin success leg";
export const EXCLUDED_ROUTES: Readonly<Record<string, string>> = {
  "GET /api/v1/directory/connect": OWNER_ONLY,
  "POST /api/v1/directory/confirm": OWNER_ONLY,
  "POST /api/v1/directory/cancel": OWNER_ONLY,
  "POST /api/v1/directory/sync": OWNER_ONLY,
  "POST /api/v1/directory/held/:groupId/confirm": OWNER_ONLY,
  "POST /api/v1/directory/disconnect": OWNER_ONLY,
  "DELETE /api/v1/directory": OWNER_ONLY,
  "POST /api/v1/admin/broker-check":
    "owner-only (the broker check): no admin success leg",
  "GET /api/v1/directory/callback":
    "needs the Google directory connector (404 without it)",
  "GET /api/v1/artifacts/:id/anon-id":
    "anonymous callers only (signed-in callers get 401), so no tenant credential crosses",
  "GET /api/v1/usage": "off on every hosted install (usage_off)",
  // #839 real-only: the throwaway each needs takes a connected Google
  // directory (an identity link, a mapping, a directory group).
  "DELETE /api/v1/members/:id/identities/google":
    "real-only: a reset needs a Google-linked member",
  "DELETE /api/v1/spaces/:id/mappings/:groupId":
    "real-only: a mapping row needs a connected Google directory",
  "DELETE /api/v1/directory/restricted-groups/:groupId":
    "real-only: a restricted group needs a directory group (Google)",
};

/**
 * The surfaces dropped from the cross-install suite (P5 plan, Task 3b;
 * #655), each with the tests that cover it instead. The coverage check
 * fails unless this matches exactly the surfaces the rules drop, and
 * `citationGaps` fails unless every cited file, describe and test exists.
 */
export const DROPPED: Readonly<
  Record<string, { why: DropWhy; coveredBy: readonly Citation[] }>
> = {
  "artifact anon id": { why: "no-world-caller", coveredBy: [ARTIFACTS] },
  "artifact content /p/": { why: "credential-free", coveredBy: [ARTIFACTS] },
  "org GET /api/v1/directory/connect": {
    why: "owner-only",
    coveredBy: [INSTANCE],
  },
  "org POST /api/v1/directory/confirm": {
    why: "owner-only",
    coveredBy: [INSTANCE],
  },
  "org POST /api/v1/directory/cancel": {
    why: "owner-only",
    coveredBy: [INSTANCE],
  },
  "org POST /api/v1/directory/sync": {
    why: "owner-only",
    coveredBy: [INSTANCE],
  },
  "org POST /api/v1/directory/held/:groupId/confirm": {
    why: "owner-only",
    coveredBy: [INSTANCE],
  },
  "org POST /api/v1/directory/disconnect": {
    why: "owner-only",
    coveredBy: [INSTANCE, DISCONNECT],
  },
  "org DELETE /api/v1/directory": {
    why: "owner-only",
    coveredBy: [INSTANCE, DISCONNECT],
  },
  "org POST /api/v1/admin/broker-check": {
    why: "owner-only",
    coveredBy: [
      INSTANCE,
      {
        file: FOREIGN,
        describe: "red line: another install's credential on the broker check",
        test: "POST admin/broker-check: another install's owner session or PAT is refused with no audit row and no broker call; this install's owner runs it",
      },
      {
        file: "apps/server/test/broker-check.test.ts",
        describe: "who may run it",
      },
    ],
  },
  "org GET /api/v1/directory/callback": {
    why: "no-directory",
    coveredBy: [
      INSTANCE,
      {
        file: FOREIGN,
        describe: FOREIGN_D,
        test: "GET directory/callback: another install's session or PAT is refused with no audit row; this install's owner reaches the handler",
      },
    ],
  },
  "space mapping delete viewer": {
    why: "no-directory",
    coveredBy: [
      BY_PERSONAL[0] as Citation,
      {
        file: FOREIGN,
        describe: FOREIGN_D,
        test: "DELETE a space viewer mapping: another install's session or PAT is refused and the mapping stays; this install's admin deletes it",
      },
    ],
  },
  "space mapping delete a manager mapping": {
    why: "no-directory",
    coveredBy: [
      BY_PERSONAL[0] as Citation,
      {
        file: FOREIGN,
        describe: FOREIGN_D,
        test: "DELETE a space manager mapping: another install's session or PAT is refused and the mapping stays; this install's admin deletes it",
      },
    ],
  },
  "org GET /api/v1/usage": {
    why: "feature-off",
    coveredBy: [
      INSTANCE,
      {
        file: "apps/server/test/usage.test.ts",
        describe: "usage_off",
        test: "usage_off → GET /api/v1/usage 404 for the owner",
      },
    ],
  },
  "org DELETE /api/v1/members/:id/identities/google": {
    why: "real-only",
    coveredBy: [INSTANCE],
  },
  "org DELETE /api/v1/spaces/:id/mappings/:groupId": {
    why: "real-only",
    coveredBy: [INSTANCE],
  },
  "org DELETE /api/v1/directory/restricted-groups/:groupId": {
    why: "real-only",
    coveredBy: [INSTANCE],
  },
  "space patch {} (personal)": { why: "nobody", coveredBy: BY_PERSONAL },
  "space delete (personal)": { why: "nobody", coveredBy: BY_PERSONAL },
  "space member put (personal)": { why: "nobody", coveredBy: BY_PERSONAL },
  "space member delete (personal)": { why: "nobody", coveredBy: BY_PERSONAL },
  "space mapping put (personal)": { why: "nobody", coveredBy: BY_PERSONAL },
  "space mapping delete (personal)": { why: "nobody", coveredBy: BY_PERSONAL },
};

/**
 * Citations that don't resolve: a missing file, or a describe or test name
 * not found verbatim (quoted) in it. `read` returns a repo file's text, or
 * null when it doesn't exist. Empty when every citation resolves.
 */
export function citationGaps(
  read: (repoPath: string) => string | null,
): string[] {
  const gaps: string[] = [];
  const quoted = (text: string, s: string) =>
    ['"', "'", "`"].some((q) => text.includes(`${q}${s}${q}`));
  for (const [name, d] of Object.entries(DROPPED)) {
    if (d.coveredBy.length === 0) gaps.push(`${name}: no covering test`);
    for (const c of d.coveredBy) {
      const text = read(c.file);
      if (text === null) gaps.push(`${name}: missing file ${c.file}`);
      else {
        if (!quoted(text, c.describe))
          gaps.push(`${name}: no describe "${c.describe}" in ${c.file}`);
        if (c.test !== undefined && !quoted(text, c.test))
          gaps.push(`${name}: no test "${c.test}" in ${c.file}`);
      }
    }
  }
  return gaps;
}

export interface Dropped {
  name: string;
  routes: readonly string[];
  why: DropWhy;
  reason: string;
}

export interface Derived {
  cases: ProbeCase[];
  dropped: Dropped[];
  /** Mutating instance routes: no throwaway exists for them (a gap). */
  unsupported?: string[];
}

/** Every probe as cases or drops, by rule. Pure: derived from Backend's lists. */
export function derive(): Derived {
  const cases: ProbeCase[] = [];
  const dropped: Dropped[] = [];
  const unsupported: string[] = [];
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
    if (orgExpected(CALLER, s.rule, s.route) === "deny") {
      drop(name, [s.route], "owner-only");
      continue;
    }
    const p = ROUTE_POLICY[s.route];
    if (
      p &&
      "offWhen" in p &&
      p.offWhen &&
      HOSTED_FEATURES.includes(p.offWhen)
    ) {
      drop(name, [s.route], "feature-off");
      continue;
    }
    if ((NO_DIRECTORY.org as readonly string[]).includes(s.route)) {
      drop(name, [s.route], "no-directory");
      continue;
    }
    // An instance route that writes has no throwaway to write to: it must
    // be dropped with a reason, or the coverage check fails.
    if (s.mutates) {
      unsupported.push(name);
      continue;
    }
    // #839: a real write on a throwaway the install makes for itself
    // (crossWrite) wherever a refusal-mode request would touch the world or
    // none exists; a realOnly route with no throwaway is a recorded drop.
    const fresh = ORG_FRESH[s.route];
    if (s.realOnly === true && !fresh) {
      drop(name, [s.route], "real-only");
      continue;
    }
    if (fresh) {
      cases.push({
        name: `${name} [session]`,
        routes: [s.route],
        variant: "session",
        write: {
          fresh,
          run: (cred, t, x, fetch) =>
            s.probe(t.app, cred, orgThrowaway(x), { fetch }),
        },
      });
      continue;
    }
    // Writes send the session cookie with X-OA-Request (#839) and stop past
    // the access rules; reads take either credential.
    for (const v of variants(!s.route.startsWith("GET ")))
      cases.push({
        name: `${name} [${v}]`,
        routes: [s.route],
        variant: v,
        run: (cred, t, w, fetch) => s.probe(t.app, cred, w.org, { fetch }),
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
              // The guard space, never the world's: a regression that lets
              // "delete (S)" through deletes nothing the suite relies on.
              run: (cred, t, w, fetch) =>
                s.probe(t.app, cred, w.guard, { fetch }),
            }),
      });
  }
  return { cases, dropped, unsupported };
}

/** The realOnly instance writes a throwaway serves (the rest are dropped). */
export const ORG_FRESH: Readonly<Record<string, Fresh>> = {
  "DELETE /api/v1/tokens/:id": "token",
  "PATCH /api/v1/oauth-clients/:grantId": "grant",
  "DELETE /api/v1/oauth-clients/:grantId": "grant",
  "DELETE /api/v1/spaces/:id/members/:userId": "space",
  // The throwaway's member is a viewer already: a no-op 200.
  "PUT /api/v1/spaces/:id/members/:userId": "space",
  // The empty throwaway itself goes (204), never the world space.
  "DELETE /api/v1/spaces/:id": "space",
};

/** An instance probe's real-mode target on a throwaway. */
const orgThrowaway = (x: Throwaway): OrgTarget => ({
  spaceId: x.space?.cloneId ?? "",
  memberId: "",
  departedId: "",
  real: {
    ...(x.tokenId ? { tokenId: x.tokenId } : {}),
    ...(x.grantId ? { grantId: x.grantId } : {}),
    ...(x.space?.cloneId
      ? {
          spaceId: x.space.cloneId,
          spaceEditorId: x.space.editorId,
          memberId: x.space.memberId,
        }
      : {}),
  },
});

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
  const { cases, dropped, unsupported = [] } = d;
  const recorded = dropped.filter((x) => DROPPED[x.name]?.why === x.why);
  // Only a case covers a route; a drop never does.
  const reached = new Set(cases.flatMap((c) => c.routes));
  const droppedRoutes = new Set(recorded.flatMap((x) => x.routes));
  const derivedNames = new Set(dropped.map((x) => x.name));
  const scoped = Object.keys(ROUTE_POLICY).filter(
    (k) => !PUBLIC_ROUTES.includes(k),
  );
  const tools = Object.keys(TOOL_POLICY).map((t) => `tool:${t}`);
  const content = Object.keys(CONTENT_POLICY)
    .filter((k) => !CONTENT_PUBLIC.includes(k))
    .map((k) => `content:${k}`);
  const missing = [...scoped, ...tools, ...content].filter(
    (k) => !reached.has(k),
  );
  const gaps = [
    ...unsupported.map(
      (n) => `mutating instance route with no throwaway: ${n}`,
    ),
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
      .filter(([, v]) => v.coveredBy.length === 0)
      .map(([n]) => `drop without a covering test: ${n}`),
    // A route no case reaches must be an explicit exclusion, reached by a
    // recorded drop; an exclusion a case reaches (or no drop backs) is stale.
    ...missing
      .filter((k) => !(k in EXCLUDED_ROUTES))
      .map((k) => `no case: ${k}`),
    ...Object.keys(EXCLUDED_ROUTES)
      .filter((k) => reached.has(k) || !droppedRoutes.has(k))
      .map((k) => `stale exclusion: ${k}`),
  ];
  // The probe list is never shorter than the policy manifest it covers.
  const n = cases.length + Object.keys(EXCLUDED_ROUTES).length;
  if (n < scoped.length + tools.length)
    gaps.push(
      `${n} cases and exclusions < ${scoped.length} scoped routes + ${tools.length} tools`,
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

/** True when `req` carries `cred`: its session cookie or its bearer token. */
export function carries(req: Request, cred: ProbeCred): boolean {
  if (cred.cookie)
    return (req.headers.get("cookie") ?? "")
      .split(/;\s*/)
      .includes(cred.cookie);
  if (cred.token)
    return req.headers.get("authorization") === `Bearer ${cred.token}`;
  return false;
}

/** Reads a repo file for citationGaps (null when missing). */
export function readRepoFile(repoPath: string): string | null {
  try {
    return readFileSync(join(REPO, repoPath), "utf8");
  } catch {
    return null;
  }
}
const REPO = join(import.meta.dirname, "..", "..", "..");

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
  o: { setup?: boolean } = {},
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
  const req = new Request(
    `${t.app}${path}`,
    withCred(pat, { method, headers, body: b }),
  );
  // A setup publish: SETUP_PUBLISH_MS, a timeout is infra (never retried).
  const { res, text } = o.setup
    ? await setupFetch(t.name, req)
    : await fetch(req).then(async (r) => ({ res: r, text: await readBody(r) }));
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

/** The hook's space id rule (apps/server/src/test-hooks SPACE_ID). */
export const HOOK_SPACE_ID = /^test-[A-Za-z0-9_-]{1,59}$/;

/**
 * The fixed hook spaces (the test-hook `test-` prefix rule), reused across
 * runs, per TEST_DOMAIN: the id ends in the first 8 hex of
 * sha256(testDomain). The hook refuses a grant on a space with any member
 * outside TEST_DOMAIN, so a domain move starts on fresh spaces instead of
 * the old domain's. `world` is the probes' space; `guard` holds one artifact
 * so "space delete (S)" answers 409, never the world's space.
 */
export function worldSpaces(testDomain: string): {
  world: string;
  guard: string;
} {
  const tag = createHash("sha256")
    .update(testDomain.toLowerCase())
    .digest("hex")
    .slice(0, 8);
  const out = {
    world: `test-redline-space-${tag}`,
    guard: `test-redline-guard-${tag}`,
  };
  for (const id of Object.values(out))
    if (!HOOK_SPACE_ID.test(id)) throw new Error(`bad hook space id ${id}`);
  return out;
}
/**
 * The fixed directory groups the space mapping probes name, per TEST_DOMAIN
 * (the same tag as worldSpaces). seedWorld seeds their directory_groups rows
 * through the directory-groups hook (`test-` ids, TEST_DOMAIN emails), so on
 * a Google-sync install with no binding the success leg is a real write, not
 * a 404 (never accepted as a pass). On sync off or frozen the put answers
 * the service's 409 (sync off), still past the access rule.
 */
export function worldGroups(testDomain: string): SpaceTarget["groups"] {
  const tag = createHash("sha256")
    .update(testDomain.toLowerCase())
    .digest("hex")
    .slice(0, 8);
  const out = {
    viewer: `test-redline-viewer-${tag}`,
    manager: `test-redline-manager-${tag}`,
    free: `test-redline-free-${tag}`,
  };
  for (const id of Object.values(out))
    if (!HOOK_SPACE_ID.test(id)) throw new Error(`bad hook group id ${id}`);
  return out;
}

/** The directory-groups hook body for `testDomain`'s world groups. */
export const groupSeed = (testDomain: string) => ({
  groups: Object.values(worldGroups(testDomain)).map((groupId) => ({
    groupId,
    email: `${groupId}@${testDomain}`,
  })),
});

const WORLD_TITLE = "test-redline-world";
const TRASH_TITLE = "test-redline-trash";
/** Reuse a trashed probe artifact only while it is this fresh: well inside the 30-day purge. */
const TRASH_REUSE_MS = 20 * 86_400_000;
const GUARD_TITLE = "test-redline-guard";

/** A member test user's id (fixed address; the session hook creates it once). */
async function memberId(t: Target, pat: Cred, who: string): Promise<string> {
  const email = `redline-${who}@${t.testDomain}`;
  await sessionCred(t, email, "member", { setup: true });
  const members = (await api(t, pat, "GET", "/api/v1/members")) as {
    id: string;
    email: string;
  }[];
  const m = members.find((x) => x.email === email);
  if (!m) throw new Error(`${t.name}: the ${who} test user is missing`);
  return m.id;
}

/** A private html artifact (db, storage, viewer; docs "d" and "probe" in "c"). */
async function newArtifact(
  side: Side,
  title: string,
  spaceId?: string,
  made?: (id: string) => void,
): Promise<string> {
  const { t, pat } = side;
  const art = (await api(
    t,
    pat,
    "POST",
    "/api/v1/artifacts",
    {
      json: {
        title,
        format: "html",
        content: `<p>${title}</p>`,
        capabilities: { db: true, storage: true, viewer: true },
        visibility: "private",
        ...(spaceId ? { spaceId } : {}),
      },
    },
    undefined,
    { setup: true },
  )) as { id?: string };
  if (typeof art.id !== "string") throw new Error(`${t.name}: no artifact id`);
  // Tracked before anything else can fail, so cleanup still finds it.
  made?.(art.id);
  await resetData(side, art.id);
  return art.id;
}

async function resetData(side: Side, id: string): Promise<void> {
  const A = `/api/v1/artifacts/${id}`;
  await api(side.t, side.pat, "PUT", `${A}/data/c/d`, { json: { v: 1 } });
  await api(side.t, side.pat, "PUT", `${A}/data/c/probe`, { json: { p: 0 } });
}

/** The live artifact in `spaceId` whose title starts with `title`, made when missing. */
async function fixedArtifact(
  side: Side,
  spaceId: string,
  title: string,
): Promise<string> {
  const q = `/api/v1/artifacts?scope=space&spaceId=${encodeURIComponent(spaceId)}&limit=100`;
  const page = (await api(side.t, side.pat, "GET", q)) as {
    items?: { id: string; title?: string }[];
  };
  const hit = page.items?.find((a) => a.title?.startsWith(title));
  return hit ? hit.id : newArtifact(side, title, spaceId);
}

/**
 * A deleted artifact in `spaceId` for the trash probe: the newest one
 * titled TRASH_TITLE still well inside the purge window, else a new one
 * deleted now (older ones purge on their own, so at most two a month).
 */
async function trashedArtifact(side: Side, spaceId: string): Promise<string> {
  const q = `/api/v1/trash?spaceId=${encodeURIComponent(spaceId)}&limit=100`;
  const page = (await api(side.t, side.pat, "GET", q)) as {
    items?: { id: string; title?: string; deletedAt?: string }[];
  };
  const hit = page.items?.find(
    (a) =>
      a.title === TRASH_TITLE &&
      Date.now() - Date.parse(a.deletedAt ?? "") < TRASH_REUSE_MS,
  );
  if (hit) return hit.id;
  const id = await newArtifact(side, TRASH_TITLE, spaceId);
  await api(side.t, side.pat, "DELETE", `/api/v1/artifacts/${id}`);
  return id;
}

/**
 * Seeds what the probes need on `side`'s install (the WORLD of
 * apps/server/test/authz/expect.ts, for the admin test user), reusing the
 * same state every run:
 * - two fixed hook spaces the admin manages (worldSpaces(testDomain));
 * - one fixed html artifact in each, the world's reset per run (title
 *   carries its id and this run's marker; a thumbnail; doc "d" in "c");
 * - fixed member test users (the org probes' member and departed target,
 *   the space probes' member, editor and peer manager).
 * Only fixed state is made here (once), so a failure partway leaves no
 * per-run state behind.
 */
export async function seedWorld(side: Side): Promise<World> {
  const { t, pat, marker } = side;
  const { world: WORLD_SPACE, guard: GUARD_SPACE } = worldSpaces(t.testDomain);
  // The hook creates the prefixed spaces if missing and grants the admin.
  await hook(
    t,
    "/__test/session",
    {
      email: adminEmail(t),
      role: "admin",
      spaces: [
        { spaceId: WORLD_SPACE, role: "manager" },
        { spaceId: GUARD_SPACE, role: "manager" },
      ],
    },
    { setup: true },
  );
  // The mapping probes' groups (idempotent; harmless when sync is off).
  await hook(t, "/__test/directory-groups", groupSeed(t.testDomain), {
    setup: true,
  });
  const groups = worldGroups(t.testDomain);
  const users = {
    member: await memberId(t, pat, "member"),
    editor: await memberId(t, pat, "editor"),
    manager: await memberId(t, pat, "manager"),
  };
  const id = await fixedArtifact(side, WORLD_SPACE, WORLD_TITLE);
  await fixedArtifact(side, GUARD_SPACE, GUARD_TITLE);
  const A = `/api/v1/artifacts/${id}`;
  // Search probes look the artifact up by id; leaks are judged by the marker.
  await api(t, pat, "PATCH", A, {
    json: { title: `${WORLD_TITLE} ${marker} ${id}`, visibility: "private" },
  });
  await api(t, pat, "PUT", `${A}/thumbnail`, {
    raw: WEBP,
    type: "image/webp",
  });
  await resetData(side, id);
  const trashedId = await trashedArtifact(side, WORLD_SPACE);
  const got = (await api(t, pat, "GET", A)) as { space?: { id?: unknown } };
  if (got.space?.id !== WORLD_SPACE)
    throw new Error(`${t.name}: the probe artifact is not in the world space`);
  return {
    artifactId: id,
    personalId: side.markerId,
    trashedId,
    spaceId: WORLD_SPACE,
    users,
    org: {
      spaceId: WORLD_SPACE,
      memberId: users.member,
      departedId: users.member,
    },
    space: spaceTarget(WORLD_SPACE, users, groups),
    guard: spaceTarget(GUARD_SPACE, users, groups),
  };
}

const spaceTarget = (
  spaceId: string,
  u: World["users"],
  groups: SpaceTarget["groups"],
  cloneId?: string,
): SpaceTarget => ({
  spaceId,
  // The personal-space probes are dropped (DROPPED): nobody is allowed.
  personalSpaceId: "",
  memberId: u.member,
  editorId: u.editor,
  managerId: u.manager,
  // Seeded by seedWorld (worldGroups): a real write on Google-sync
  // installs, the service's 409 (sync off) elsewhere; both past the rule.
  groups,
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
  const { t, pat } = side;
  if (fresh === "token") {
    // PATs can't mint PATs: the admin's session, as the app sends it.
    const r = await fetch(
      `${t.app}/api/v1/tokens`,
      withCred(side.cookie, {
        method: "POST",
        headers: { "content-type": "application/json", "x-oa-request": "1" },
        body: JSON.stringify({
          label: `test-redline-throwaway ${side.marker.slice(-8)}`,
        }),
      }),
    );
    const body = await readBody(r);
    if (r.status !== 201)
      throw new HttpError(`${t.name} throwaway token`, r, body);
    x.tokenId = (parseJson(r, body, "token") as { id: string }).id;
    return x;
  }
  if (fresh === "grant") {
    // The consent flow, as the admin (the code names the grant). Listed
    // before and after, so a code without one still finds the grant and
    // dispose always revokes it.
    const before = new Set(await grantIds(side));
    const code = await authorizeCode(
      t,
      side.cookie,
      await registerClient(t),
      pkce(),
      mcpResource(t),
    );
    const grantId =
      code.split(":")[1] ||
      (await grantIds(side)).find((id) => !before.has(id));
    if (!grantId) throw new Error(`${t.name}: the consent made no grant`);
    x.grantId = grantId;
    return x;
  }
  if (fresh === "space") {
    // A real (unprefixed) space: deleted after the case (it holds no artifact).
    const space = (await api(t, pat, "POST", "/api/v1/spaces", {
      json: { name: `test-redline-throwaway ${side.marker.slice(-8)}` },
    })) as { id?: string };
    if (typeof space.id !== "string") throw new Error(`${t.name}: no space id`);
    const clone = space.id;
    x.space = spaceTarget(w.spaceId, w.users, w.space.groups, clone);
    await api(t, pat, "POST", `/api/v1/spaces/${clone}/members/self`, {
      json: { role: "manager" },
    });
    const put = (id: string, role: string) =>
      api(t, pat, "PUT", `/api/v1/spaces/${clone}/members/${id}`, {
        json: { role },
      });
    await put(w.users.member, "viewer");
    await put(w.users.editor, "editor");
    await put(w.users.manager, "manager");
  } else {
    await newArtifact(
      side,
      `test-redline-throwaway ${side.marker.slice(-8)}`,
      fresh === "artifact-space" ? w.spaceId : undefined,
      (id) => {
        x.artifactId = id;
      },
    );
    // The unshare probes remove this share (as the matrix seeds it).
    await api(t, pat, "PUT", `/api/v1/artifacts/${need(x.artifactId)}/shares`, {
      json: { email: PROBE_SHARE_EMAIL, role: "viewer" },
    });
  }
  return x;
}

/** Status and body of each GET, as the install's own admin sees them. */
async function reads(side: Side, paths: string[]): Promise<string> {
  const out: string[] = [];
  for (const p of paths) {
    const r = await fetch(`${side.t.app}${p}`, withCred(side.pat));
    const body = await readBody(r);
    // A snapshot that isn't a 200 proves nothing about the throwaway.
    if (r.status !== 200)
      throw new HttpError(`${side.t.name} snapshot GET ${redact(p)}`, r, body);
    out.push(`${p} ${body}`);
  }
  return out.join("\n");
}

/**
 * What a write would change on a throwaway: the artifact (metadata, data,
 * shares, versions) or the space (settings, members, mappings). Every read
 * must answer 200.
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
  // Only the throwaway's own entry: the reading PAT's lastUsedAt moves.
  if (x.tokenId) return entry(side, "/api/v1/tokens", x.tokenId);
  if (x.grantId) return entry(side, "/api/v1/oauth-clients", x.grantId);
  throw new Error(`${side.t.name}: an empty throwaway has no snapshot`);
}

/** The admin's grant ids (GET R.oauthClients). */
async function grantIds(side: Side): Promise<string[]> {
  const v = (await api(side.t, side.pat, "GET", "/api/v1/oauth-clients")) as
    | { grantId: string }[]
    | { items?: { grantId: string }[] };
  return (Array.isArray(v) ? v : (v.items ?? [])).map((g) => g.grantId);
}

/** The list entry with `id` (the "grantId" or "id" field), as text; it must be there. */
async function entry(side: Side, path: string, id: string): Promise<string> {
  const r = await fetch(`${side.t.app}${path}`, withCred(side.pat));
  const body = await readBody(r);
  if (r.status !== 200)
    throw new HttpError(`${side.t.name} snapshot GET ${path}`, r, body);
  const v = parseJson(r, body, path) as unknown;
  const list = (
    Array.isArray(v) ? v : ((v as { items?: unknown[] }).items ?? [])
  ) as {
    id?: string;
    grantId?: string;
  }[];
  const e = list.find((x) => x.id === id || x.grantId === id);
  if (!e)
    throw new Error(`${side.t.name} snapshot: ${path} lacks the throwaway`);
  return JSON.stringify(e);
}

/** How long `settle` waits for indexing, and how often it looks. */
export const SETTLE_MS = 30_000;
export const SETTLE_POLL_MS = 500;

/**
 * Settles what the server changes on its own after a publish, so the
 * snapshots before and after A's attempt see only what a write could change
 * (call it before the "before" snapshot of an artifact throwaway):
 * - thumbnailUrl/thumbnailVersion: with server thumbnails on, a capture of
 *   the current version runs after indexing (and may defer or retry for a
 *   minute or more). A client thumbnail of the current version, stored here
 *   first, makes that capture a skip (or a same-version rewrite), so neither
 *   field moves. A's write is refused before any thumbnail rule (A is
 *   unknown to B), so this can't hide a thumbnail write.
 * - versions[].textIndexed: the index alarm flips it to true about
 *   LIMITS.indexDebounceMs after a publish. Waits until every entry is true,
 *   polling every `pollMs`, at most `ms`; a timeout is an InfraError.
 * Spaces have neither, so a space throwaway settles at once.
 */
export async function settle(
  side: Side,
  x: Throwaway,
  o: { ms?: number; pollMs?: number } = {},
): Promise<void> {
  if (!x.artifactId) return;
  const { t, pat } = side;
  const A = `/api/v1/artifacts/${x.artifactId}`;
  await api(t, pat, "PUT", `${A}/thumbnail`, { raw: WEBP, type: "image/webp" });
  const ms = o.ms ?? SETTLE_MS;
  const pollMs = o.pollMs ?? SETTLE_POLL_MS;
  const end = Date.now() + ms;
  for (;;) {
    const v = (await api(t, pat, "GET", `${A}/versions`)) as unknown;
    const list = Array.isArray(v)
      ? v
      : ((v as { items?: unknown } | null)?.items ?? null);
    if (!Array.isArray(list))
      throw new Error(`${t.name} settle: /versions is not a list`);
    if (
      list.every(
        (e) => (e as { textIndexed?: unknown } | null)?.textIndexed === true,
      )
    )
      return;
    if (Date.now() + pollMs > end)
      throw new InfraError(
        `${t.name}: the throwaway's versions were not text-indexed within ${Math.round(ms / 1000)}s`,
      );
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

const redact = (path: string) => path.replace(/[A-Za-z0-9_-]{16,}/g, ":id");

/** DELETE `path` as `side`'s admin. Anything but a 200 or 204 throws. */
export async function cleanup(side: Side, path: string): Promise<void> {
  const r = await fetch(
    `${side.t.app}${path}`,
    withCred(side.pat, { method: "DELETE" }),
  );
  const body = await readBody(r);
  if (r.status !== 200 && r.status !== 204)
    throw new HttpError(
      `${side.t.name} cleanup DELETE ${redact(path)}`,
      r,
      body,
    );
}

/**
 * Deletes a throwaway. Artifacts go to the trash: no API purges it, and the
 * nightly purgeDeleted hard-deletes trash after LIMITS.softDeleteDays, so
 * they stay bounded. Throwaway spaces hold no artifact and are deleted.
 */
export async function dispose(side: Side, x: Throwaway): Promise<void> {
  LIVE.get(side.t)?.delete(x);
  if (x.artifactId) {
    const id = x.artifactId;
    const A = `/api/v1/artifacts/${id}`;
    await cleanup(side, A).catch(async (e) => {
      // A 404 is clean only when a delete probe already trashed it. Shared
      // space trash isn't listable, so prove it: undelete must answer 200
      // (it was in the trash), then the delete must answer 200 or 204.
      if (!(e instanceof HttpError && e.status === 404)) throw e;
      await api(side.t, side.pat, "POST", `${A}/undelete`, undefined, [200]);
      await cleanup(side, A);
    });
  }
  // Gone already when B's own probe ran (the success leg revokes the
  // token or grant, or deletes the space): a 404 then.
  const revoke = async (path: string) =>
    cleanup(side, path).catch((e) => {
      if (!(e instanceof HttpError && e.status === 404)) throw e;
    });
  if (x.space?.cloneId) await revoke(`/api/v1/spaces/${x.space.cloneId}`);
  if (x.tokenId) await revoke(`/api/v1/tokens/${x.tokenId}`);
  if (x.grantId) await revoke(`/api/v1/oauth-clients/${x.grantId}`);
}

/** Disposes every throwaway still live on `side`'s install; throws the first failure after trying all. */
export async function sweep(side: Side): Promise<void> {
  let first: unknown;
  for (const x of [...(LIVE.get(side.t) ?? [])])
    await dispose(side, x).catch((e) => {
      first ??= e;
    });
  if (first) throw first;
}
