import {
  type Anchor,
  type AnchorInput,
  type ArtifactAgent,
  ASK_TO_MAX,
  type AskInput,
  AskInputSchema,
  anchorInputSchema,
  BusAddressSchema,
  type Comment,
  type CommentAuthor,
  type CommentList,
  isId,
  type KeyRef,
  type MentionDelivery,
  type CommentThread as Thread,
  type ThreadAgent,
} from "@oa/shared";
import { canConnect } from "../auth/agents.js";
import {
  type ArtifactRow,
  accessLevel,
  callerOf,
  meetsLevel,
} from "../auth/authz.js";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { logError, logInfo } from "../log.js";
import {
  bodyOk,
  type NewExtras,
  type ParticipantRow,
  type StoredActor,
  type StoredAgent,
  type StoredAsk,
  type StoredComment,
  type StoredIdentity,
  type StoredParticipant,
  type StoredParty,
  type StoredPick,
  type StoredThread,
} from "../runtime/comments-store.js";
import { runtimeCall, runtimeStub } from "../runtime/do.js";
import {
  agentFace,
  agentOwnedBy,
  type FaceViewer,
  forLine,
  type NameClashes,
  nameClashes,
  partyIdentityFace,
  plainAgentName,
  shownName,
} from "./agent-display.js";
import { type AgentAttr, viaKey } from "./agent-usage.js";
import {
  addresseeOf,
  addressees,
  askRows,
  indexAnswered,
  indexAsk,
  indexDeleted,
  indexStatus,
  reconcileAsks,
} from "./asks.js";
import { agentIdentityOf, agentNamesOf, busHub } from "./bus.js";
import {
  type AskerAddress,
  agentKey,
  agentRoster,
  askerRoster,
  type CommentNoticeKind,
  type DeliveryState,
  notifyAgent,
  notifyAnswered,
  type RosterAgent,
  storedAgent,
  viewerRosterAgents,
} from "./comment-agents.js";
import {
  verifyQuote,
  versionEntryHash,
  versionFormat,
} from "./comment-anchor.js";
import { emailCommentRecipients } from "./comment-email.js";
import { type CommentStatus, cleanGuestName } from "./comment-rules.js";
import {
  addressKey,
  follow,
  inBackground,
  notifyCommented,
} from "./follows.js";
import { confirmFor, pickChallenge, verifyPick } from "./passkeys.js";
import { getUser, shownEffectiveName } from "./users.js";

// Comments on any artifact (#682): the service the REST routes call, and the
// MCP tools after them. Storage is the artifact's DO (runtime/comments-store);
// this layer verifies anchors, builds authors and shows names the way
// agent-display.ts allows. Authorization (who may open, comment, moderate) is
// the caller's: the route, from the policy table and `can`.

/** Who is acting: a signed-in person (maybe through an agent) or a signed-out guest. */
export type CommentWho =
  | {
      kind: "user";
      id: string;
      agent?: AgentAttr | null;
      /**
       * #1797: the request authenticated with a browser session (never a PAT,
       * a grant or MCP). The route sets it from the credential kind, never
       * from the body or from a missing agent.
       */
      typed?: boolean;
    }
  | {
      kind: "guest";
      /** The per-artifact anonymous id (anon-id.ts short). */
      short: string;
      /** The rate-limit key: "ip:{key}". */
      rate: string;
      name?: string;
    };

/** Who is looking, for `me` and the privacy of agent labels. Guests without an id are `null`. */
export type CommentViewer = {
  userId: string | null;
  short: string | null;
  /** The viewer's level may delete anyone's comment (owner, manager, editor). */
  moderator?: boolean;
  /** #2035: the viewer owns the artifact (may remove any agent from a thread). */
  owner?: boolean;
  /** Signed out, or a guest-role member: sees "<person>'s agent", never a bus name (#1822). */
  guest?: boolean;
  /**
   * A guest or restricted cap (capsReads): not a full member for what reaches
   * an agent without an @ (#1900, #1968). The billing "plan" cap does not set
   * it. Signed-out visitors are `guest`.
   */
  capped?: boolean;
  /** #2080: signed out where only signed-in people may comment: no edit or delete. */
  readOnly?: boolean;
  /**
   * #2224: the viewer is an agent (an MCP caller) with this connection; absent
   * for a person. An agent sees `answer.yes` only on an ask it posted itself.
   */
  agent?: AgentAttr | null;
};

/** #2224: the viewer may take an answer on this ask as its yes: not an agent, or the agent that posted it. */
const askedByViewer = (c: StoredComment, viewer: CommentViewer): boolean => {
  if (viewer.agent === undefined) return true;
  const mine = c.author.kind === "user" ? c.author.agent : undefined;
  if (!mine || !viewer.agent) return false;
  if (mine.identity)
    return mine.identity.identityId === viewer.agent.identity?.identityId;
  return (
    !viewer.agent.identity &&
    mine.name === viewer.agent.name &&
    mine.via === (viewer.agent.via ? viaKey(viewer.agent.via) : null)
  );
};

/** Anonymous, guest-role, or capped to guest or restricted: never wakes an agent without an @. */
const outsider = (v: CommentViewer): boolean =>
  v.guest === true || v.capped === true;

const faceViewer = (v: CommentViewer): FaceViewer => ({
  userId: v.userId,
  guest: v.guest === true || v.userId === null,
  outsider: outsider(v) || v.userId === null,
});

const rateKeyOf = (w: CommentWho): string =>
  w.kind === "user" ? `u:${w.id}` : w.rate;

const actorOf = (w: CommentWho): StoredActor =>
  w.kind === "user"
    ? {
        kind: "user",
        ref: w.id,
        ...(w.typed === true && !w.agent ? { typed: true as const } : {}),
        ...(w.agent
          ? {
              agent: {
                name: w.agent.name,
                via: w.agent.via ? viaKey(w.agent.via) : null,
                // Only the server sets this, from a proof it checked (#1822).
                ...(w.agent.identity
                  ? {
                      identity: {
                        identityId: w.agent.identity.identityId,
                        name: w.agent.identity.name,
                        kind: w.agent.identity.kind,
                      },
                    }
                  : {}),
              },
            }
          : {}),
      }
    : { kind: "guest", ref: w.short, name: cleanGuestName(w.name) };

/** Seconds in a "[retry:N]" the DO put on a rate_limited message. */
const RETRY = /\s*\[retry:(\d+)\]$/;

/** A DO call, its errors as ApiError; a 429 carries Retry-After. */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await runtimeCall(fn);
  } catch (e) {
    if (e instanceof ApiError && e.code === "rate_limited") {
      const m = RETRY.exec(e.message);
      if (m)
        throw new ApiError(
          "rate_limited",
          e.message.replace(RETRY, ""),
          e.details,
          { "retry-after": m[1] as string },
        );
    }
    throw e;
  }
}

const stub = (env: Env, artifactId: string) => runtimeStub(env, artifactId);

/** 400 invalid_body: empty after trim, or over 2,000 characters. */
export function checkBody(body: unknown): string {
  if (!bodyOk(body))
    throw new ApiError(
      "invalid_body",
      "A comment is 1 to 2,000 characters after trimming",
    );
  return body.trim();
}

/** What verification produced: the anchor to store and the version it names. */
export type CheckedAnchor = { anchor: Anchor; version: number };

/**
 * An anchor as posted, checked: its schema (400 invalid_anchor), the version
 * it names (missing means current; a version that does not exist is 422
 * anchor_not_in_version) and, for a text anchor on an html version, the quote.
 * A quote the stored html shows keeps its context (re-derived when only it is
 * off). A quote it does not show (text the page's script renders, or an entry
 * too big to parse) is accepted with the live page's prefix and suffix, cut
 * to CONTEXT_CHARS each side, and no block hint: the context is as unchecked
 * as the quote, and the client resolver needs it to place a short quote
 * (#1735). Other formats get the schema check only.
 */
export async function checkAnchor(
  env: Pick<Env, "DB" | "FILES" | "PLAN">,
  a: Pick<ArtifactRow, "id" | "format" | "currentVersion">,
  raw: unknown,
  /** Runs before the version's file is read: the caller's rate limit, so a refused quote still counts. */
  beforeVerify?: () => Promise<void>,
): Promise<CheckedAnchor> {
  const p = anchorInputSchema.safeParse(raw);
  if (!p.success)
    throw new ApiError("invalid_anchor", "Invalid anchor", p.error.issues);
  const input: AnchorInput = p.data;
  const current = Math.max(1, a.currentVersion);
  if (input.kind === "note") return { anchor: input, version: current };
  const version = input.version ?? current;
  if (input.kind === "pin") {
    const format = await versionFormat(env, a.id, a.format, version);
    if (format === null)
      throw new ApiError(
        "anchor_not_in_version",
        "That version does not exist",
      );
    // v1 pins are for images and pdf; on html the hash is a free channel into the frame.
    if (format === "html")
      throw new ApiError("invalid_anchor", "Pins are not available on html", [
        { path: ["kind"], message: "Pins are not available on html" },
      ]);
    // Rate limit first: the hash may cost an R2 read (a pre-digest version).
    await beforeVerify?.();
    // The server stamps the hash from the version's own bytes: a client's value is ignored.
    const entry = await versionEntryHash(env, a.id, version);
    if (entry === null)
      throw new ApiError(
        "anchor_not_in_version",
        "That version has no entry file",
      );
    return {
      anchor: { ...input, version, contentHash: entry.hash },
      version,
    };
  }
  await beforeVerify?.();
  const found = await verifyQuote(env, a.id, a.format, version, input);
  // An html page's own code receives the anchor in the frame: its free-text
  // block hint is never stored.
  const { block: kept, ...rest } = input;
  return {
    anchor: {
      ...rest,
      ...(found === null && kept ? { block: kept } : {}),
      version,
      ...(found ?? {}),
    },
    version,
  };
}

// ------------------------------------------------------------------- views

type UserLite = { id: string; name: string | null; email: string };

export async function usersById(
  env: Env,
  ids: Iterable<string>,
): Promise<Map<string, UserLite>> {
  const list = [...new Set(ids)];
  const out = new Map<string, UserLite>();
  // D1 binds at most 100 parameters.
  for (let i = 0; i < list.length; i += 50) {
    const part = list.slice(i, i + 50);
    const { results } = await env.DB.prepare(
      `select id, email, name, display_name as displayName from users where id in (${part.map(() => "?").join(",")})`,
    )
      .bind(...part)
      .all<{
        id: string;
        email: string;
        name: string;
        displayName: string | null;
      }>();
    for (const r of results)
      out.set(r.id, {
        id: r.id,
        email: r.email,
        name: shownEffectiveName(r),
      });
  }
  return out;
}

/** What a view reads from: the users it names and who shares a name (#1822), once per call. */
type Ctx = {
  users: Map<string, UserLite>;
  clash: NameClashes;
  /** #1889: identity id to the agent's current bus name, from its owner's hub; a miss keeps the stored name. */
  names: Map<string, string>;
};

/** A party's name today: its linked agent's current bus name, else the one stored with it. */
const currentName = (
  p: { name: string; identity?: { identityId: string } },
  { names }: Ctx,
): string =>
  p.identity ? (names.get(p.identity.identityId) ?? p.name) : p.name;

const authorView = (
  a: StoredActor,
  viewer: CommentViewer,
  ctx: Ctx,
): CommentAuthor => {
  const { users, clash } = ctx;
  if (a.kind === "guest")
    return {
      kind: "guest",
      name: a.name ?? "Guest",
      me: viewer.short !== null && viewer.short === a.ref,
    };
  const u = users.get(a.ref);
  // A stored comment with an agent (written over MCP or with a token, or
  // before #1789) reads as the agent at read time; no row is migrated. A
  // linked one shows its current name (#1889), renamed before any masking.
  if (a.agent)
    return agentFace(
      {
        ref: a.ref,
        agent: a.agent.identity
          ? {
              ...a.agent,
              identity: {
                ...a.agent.identity,
                name:
                  ctx.names.get(a.agent.identity.identityId) ??
                  a.agent.identity.name,
              },
            }
          : a.agent,
      },
      faceViewer(viewer),
      u,
      clash,
    );
  const me = viewer.userId !== null && viewer.userId === a.ref;
  return { kind: "user", id: a.ref, name: u ? shownName(u) : "Member", me };
};

/** Per isolate: the name map and when it was built; stale up to CLASH_TTL_MS is fine. */
const CLASH_TTL_MS = 60_000;
let clashCache: { at: number; map: NameClashes } | null = null;
/** For tests: forget the cached name map and the cached current agent names. */
export const resetNameClashCache = (): void => {
  clashCache = null;
  namesCache.clear();
};

/** #1889: most distinct owners one view reads current names for; the rest keep stored names. */
export const NAMES_OWNERS_MAX = 25;
/** #1889: current names are kept per isolate for this long (keyed by owner and identity), at most NAMES_CACHE_MAX of them. */
export const NAMES_TTL_MS = 30_000;
const NAMES_CACHE_MAX = 2000;
const namesCache = new Map<string, { name: string; at: number }>();

/** Every member's name, removed ones too (their names stay reserved), cached. */
export async function allClashes(env: Env): Promise<NameClashes> {
  if (clashCache && Date.now() - clashCache.at < CLASH_TTL_MS)
    return clashCache.map;
  const { results } = await env.DB.prepare(
    "select id, email, name, display_name as displayName from users",
  ).all<{
    id: string;
    email: string;
    name: string;
    displayName: string | null;
  }>();
  const map = nameClashes(
    results.map((r) => ({
      id: r.id,
      email: r.email,
      name: shownEffectiveName(r),
    })),
  );
  clashCache = { at: Date.now(), map };
  return map;
}

/** Whether a comment shows an agent by name (then `for` needs the clash check). */
const hasAgent = (c: StoredComment): boolean =>
  !!c.author.agent ||
  !!c.mentions?.length ||
  !!c.notified?.length ||
  !!c.ask?.answer?.by.agent ||
  !!c.ask?.to.some((p) => p.kind === "agent");

async function ctxFor(
  env: Env,
  ids: Set<string>,
  agents: boolean,
  shown: {
    comments: StoredComment[];
    actors?: (StoredActor | null)[];
    agents?: { owner: string; identity?: StoredIdentity }[];
  } = {
    comments: [],
  },
): Promise<Ctx> {
  const [users, clash, names] = await Promise.all([
    usersById(env, ids),
    agents ? allClashes(env) : Promise.resolve(new Map() as NameClashes),
    agents
      ? currentNames(env, shown)
      : Promise.resolve(new Map<string, string>()),
  ]);
  return { users, clash, names };
}

/**
 * #1889: the current bus names of the linked agents a view shows (authors,
 * mentions, ask addressees, answerers), one hub read per owner, in parallel,
 * each bounded (LINK_LOOKUP_MS). Only an owner's own hub is asked for that
 * owner's identity ids. A miss, a timeout or a failure leaves the stored name.
 */
export async function currentNames(
  env: Env,
  s: {
    comments: StoredComment[];
    actors?: (StoredActor | null)[];
    agents?: { owner: string; identity?: StoredIdentity }[];
  },
): Promise<Map<string, string>> {
  const byOwner = new Map<string, Set<string>>();
  const add = (owner: string | undefined, id: string | undefined) => {
    if (!owner || !id) return;
    const set = byOwner.get(owner) ?? new Set<string>();
    set.add(id);
    byOwner.set(owner, set);
  };
  const actor = (a: StoredActor | null | undefined) => {
    if (a?.kind === "user") add(a.ref, a.agent?.identity?.identityId);
  };
  for (const a of s.actors ?? []) actor(a);
  for (const a of s.agents ?? []) add(a.owner, a.identity?.identityId);
  for (const c of s.comments) {
    actor(c.author);
    actor(c.ask?.answer?.by);
    for (const m of c.mentions ?? []) add(m.owner, m.identity?.identityId);
    for (const m of c.notified ?? []) add(m.owner, m.identity?.identityId);
    for (const p of c.ask?.to ?? [])
      if (p.kind === "agent") add(p.owner, p.identity?.identityId);
  }
  const out = new Map<string, string>();
  const now = Date.now();
  const need = new Map<string, string[]>();
  for (const [owner, ids] of byOwner)
    for (const id of ids) {
      const hit = namesCache.get(`${owner}\n${id}`);
      if (hit && now - hit.at < NAMES_TTL_MS) out.set(id, hit.name);
      else need.set(owner, [...(need.get(owner) ?? []), id]);
    }
  // Owners beyond the cap keep their stored names.
  await Promise.all(
    [...need].slice(0, NAMES_OWNERS_MAX).map(async ([owner, ids]) => {
      for (const [id, name] of await agentNamesOf(env, owner, ids)) {
        out.set(id, name);
        if (namesCache.size >= NAMES_CACHE_MAX) namesCache.clear();
        namesCache.set(`${owner}\n${id}`, { name, at: now });
      }
    }),
  );
  return out;
}

/** #2035: an agent a thread's replies reach, as a member sees it. */
const threadAgentView = (
  p: ParticipantRow,
  viewer: CommentViewer,
  users: Ctx,
): ThreadAgent => ({
  key: p.key,
  name: agentName(
    currentName(p, users),
    users.users.get(p.owner),
    viewer,
    users.clash,
  ),
  for: forLine(users.users.get(p.owner), faceViewer(viewer), users.clash),
  ...identityFace({ ...p, name: currentName(p, users) }, viewer, users),
  canRemove: viewer.owner === true || viewer.userId === p.owner,
  ...(p.removed ? { removed: true } : {}),
});

async function threadViews(
  env: Env,
  artifactId: string,
  threads: StoredThread[],
  viewer: CommentViewer,
): Promise<Thread[]> {
  const ids = new Set<string>();
  for (const t of threads) {
    if (t.resolvedBy?.kind === "user") ids.add(t.resolvedBy.ref);
    for (const c of t.comments) userIds(c, ids);
  }
  // #2035: members see the agents replies reach; guests, anonymous and
  // restricted members see none, as they are never told.
  const members = !outsider(viewer) && viewer.userId !== null;
  const roster = members
    ? new Map(
        await call(() =>
          stub(env, artifactId).commentsParticipants({
            threadIds: threads.map((t) => t.id),
          }),
        ),
      )
    : new Map<string, ParticipantRow[]>();
  // #2174: removed agents are listed too (marked), for members only.
  const rows = (t: StoredThread) => roster.get(t.id) ?? [];
  for (const t of threads) for (const p of rows(t)) ids.add(p.owner);
  const users = await ctxFor(
    env,
    ids,
    threads.some(
      (t) =>
        t.comments.some(hasAgent) || t.resolvedBy?.agent || rows(t).length > 0,
    ),
    {
      comments: threads.flatMap((t) => t.comments),
      actors: threads.map((t) => t.resolvedBy),
      agents: threads.flatMap(rows),
    },
  );
  return threads.map((t) => ({
    id: t.id,
    anchor: t.anchor,
    version: t.version,
    status: t.status,
    resolvedBy: t.resolvedBy ? authorView(t.resolvedBy, viewer, users) : null,
    resolvedAt: t.resolvedAt,
    createdAt: t.createdAt,
    comments: t.comments.map((c) => commentOf(c, viewer, users)),
    ...(rows(t).length
      ? { agents: rows(t).map((p) => threadAgentView(p, viewer, users)) }
      : {}),
  }));
}

/** The users a comment shows by name: its author and, on an ask, who was asked and who answered. */
function userIds(c: StoredComment, into: Set<string>): void {
  if (c.author.kind === "user") into.add(c.author.ref);
  for (const m of c.mentions ?? []) if (m.owner) into.add(m.owner);
  for (const m of c.notified ?? []) if (m.owner) into.add(m.owner);
  if (!c.ask) return;
  for (const p of c.ask.to) into.add(p.kind === "user" ? p.key : p.owner);
  if (c.ask.answer?.by.kind === "user") into.add(c.ask.answer.by.ref);
  if (c.ask.decider) into.add(c.ask.decider);
  for (const p of c.ask.history ?? [])
    if (p.by.kind === "user") into.add(p.by.ref);
}

/** #2381: the latest pick of each person, oldest first by their last change. */
const latestPicks = (h: readonly StoredPick[]): StoredPick[] => {
  const last = new Map<string, StoredPick>();
  for (const p of h) {
    last.delete(p.by.ref);
    last.set(p.by.ref, p);
  }
  return [...last.values()];
};

/** The viewer's part in an ask (#2381): decides, weighs in, or neither. Agents are neither. */
const roleOf = (
  c: StoredComment,
  ask: StoredAsk,
  viewer: CommentViewer,
): "decide" | "weigh" | undefined => {
  if (viewer.userId === null || viewer.agent !== undefined) return undefined;
  if ((ask.decider ?? c.author.ref) === viewer.userId) return "decide";
  const risky = ask.confirm === "passkey" || ask.options.some((o) => o.action);
  const asked = ask.to.some(
    (p) => (p.kind === "user" ? p.key : p.owner) === viewer.userId,
  );
  return asked && !risky ? "weigh" : undefined;
};

/** Someone an ask names, as an author: a person by name, an agent by its roster name (`me` when it is the viewer's). */
const partyView = (
  p: StoredParty,
  viewer: CommentViewer,
  users: Ctx,
): CommentAuthor =>
  p.kind === "user"
    ? authorView({ kind: "user", ref: p.key }, viewer, users)
    : {
        // A stored identity adds linked, product and animal (#1890); a party
        // without one keeps this shape, with no `linked`.
        ...identityFace({ ...p, name: currentName(p, users) }, viewer, users),
        kind: "agent",
        id: p.key,
        name: agentName(
          currentName(p, users),
          users.users.get(p.owner),
          viewer,
          users.clash,
        ),
        for: forLine(users.users.get(p.owner), faceViewer(viewer), users.clash),
        me: viewer.userId !== null && viewer.userId === p.owner,
      };

/** The identity fields of a named agent, from its stored identity; none without one. */
const identityFace = (
  p: {
    name: string;
    owner?: string;
    identity?: StoredIdentity;
  },
  viewer: CommentViewer,
  users: Ctx,
): Pick<CommentAuthor, "linked" | "product" | "animal"> => {
  if (!p.identity || !p.owner || outsider(viewer) || viewer.userId === null)
    return {};
  const f = partyIdentityFace(
    { name: p.name, owner: p.owner, identity: p.identity },
    faceViewer(viewer),
    users.users.get(p.owner),
    users.clash,
  );
  return {
    linked: f.linked,
    ...(f.product ? { product: f.product } : {}),
    ...(f.animal ? { animal: f.animal } : {}),
  };
};

/** A roster agent's bus name; a guest sees "<owner>'s agent" instead (#1822). */
const agentName = (
  bus: string,
  owner: UserLite | undefined,
  viewer: CommentViewer,
  clash: NameClashes,
): string =>
  faceViewer(viewer).guest && !(viewer.userId && viewer.userId === owner?.id)
    ? agentOwnedBy(owner, clash)
    : plainAgentName(bus);

const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A body with each "@<stored name>" of a mention swapped for the
 * name shown (one pass), whatever the case. An "@" inside a word, an email or
 * a URL is not a mention, and a longer name wins over its prefix. A name
 * with more letters after it is masked too, so no bus name stays visible.
 */
export const maskBody = (body: string, pairs: [string, string][]): string => {
  const changed = pairs.filter(([from, to]) => from !== to);
  if (changed.length === 0) return body;
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}_.+\\-/])(?:${changed
      .map(([f]) => `@${escRe(f)}`)
      .sort((x, y) => y.length - x.length)
      .join("|")})`,
    "giu",
  );
  const exact = new Map(changed.map(([f, t]) => [`@${f}`.toLowerCase(), t]));
  return body.replace(re, (m) => {
    const t =
      exact.get(m.toLowerCase()) ??
      changed.find(([f]) => new RegExp(`^@${escRe(f)}$`, "iu").test(m))?.[1];
    return t === undefined ? m : `@${t}`;
  });
};

/** A stored actor a person typed in the web app (#1797); an agent row or an old row is not. */
const isTyped = (a: StoredActor): boolean =>
  a.kind === "user" && a.typed === true && !a.agent;

/** #2381: who decides, who chose them, the viewer's part and everyone's latest pick. */
const deciderFields = (
  c: StoredComment,
  ask: StoredAsk,
  viewer: CommentViewer,
  users: Ctx,
) => {
  const who = ask.decider ?? c.author.ref;
  const role = roleOf(c, ask, viewer);
  const named = ask.decider !== undefined && ask.decider !== c.author.ref;
  return {
    decider: authorView({ kind: "user", ref: who }, viewer, users),
    ...(named ? { chosenBy: authorView(c.author, viewer, users) } : {}),
    ...(role ? { role } : {}),
    ...(named &&
    !ask.answer &&
    !ask.closed &&
    viewer.userId === c.author.ref &&
    viewer.agent === undefined
      ? { canTakeBack: true }
      : {}),
    picks: latestPicks(ask.history ?? []).map((p) => ({
      by: authorView(p.by, viewer, users),
      optionId: p.optionId,
      at: p.at,
      typed: isTyped(p.by),
      ...(p.verified && !outsider(viewer) ? { verified: p.verified } : {}),
      ...(p.guest ? { guest: true } : {}),
    })),
  };
};

const commentOf = (
  c: StoredComment,
  viewer: CommentViewer,
  users: Ctx,
): Comment => {
  const author = authorView(c.author, viewer, users);
  const shown = (c.mentions ?? []).map((m) =>
    agentName(
      currentName(m, users),
      m.owner ? users.users.get(m.owner) : undefined,
      viewer,
      users.clash,
    ),
  );
  const asked = (c.ask?.to ?? []).flatMap((p): [string, string][] =>
    p.kind === "agent"
      ? [
          [
            p.name,
            agentName(
              currentName(p, users),
              users.users.get(p.owner),
              viewer,
              users.clash,
            ),
          ],
        ]
      : [],
  );
  const pairs: [string, string][] = [
    ...(c.mentions ?? []).map((m, i): [string, string] => [
      m.name,
      shown[i] ?? m.name,
    ]),
    ...asked,
  ];
  return {
    id: c.id,
    body: maskBody(c.body, pairs),
    author,
    createdAt: c.createdAt,
    editedAt: c.editedAt,
    typed: isTyped(c.author),
    can: viewer.readOnly
      ? { edit: false, delete: false }
      : { edit: author.me, delete: author.me || viewer.moderator === true },
    ...(c.ask
      ? {
          ask: {
            question: maskBody(c.ask.question, pairs),
            options: c.ask.options.map((o) => ({
              ...o,
              label: maskBody(o.label, pairs),
              ...(o.detail !== undefined
                ? { detail: maskBody(o.detail, pairs) }
                : {}),
            })),
            ...(c.ask.recommended
              ? {
                  recommended: {
                    ...c.ask.recommended,
                    why: maskBody(c.ask.recommended.why, pairs),
                  },
                }
              : {}),
            to: c.ask.to.map((p) => partyView(p, viewer, users)),
            ...(c.ask.confirm ? { confirm: c.ask.confirm } : {}),
            ...deciderFields(c, c.ask, viewer, users),
            ...(c.ask.answer
              ? {
                  answer: {
                    optionId: c.ask.answer.optionId,
                    by: authorView(c.ask.answer.by, viewer, users),
                    at: c.ask.answer.at,
                    typed: isTyped(c.ask.answer.by),
                    ...(c.ask.answer.verified
                      ? { verified: c.ask.answer.verified }
                      : {}),
                    yes:
                      viewer.userId !== null &&
                      (c.ask.confirm !== "passkey" ||
                        c.ask.answer.verified === "passkey") &&
                      isTyped(c.ask.answer.by) &&
                      c.ask.answer.by.ref === viewer.userId &&
                      c.author.kind === "user" &&
                      c.author.ref === viewer.userId &&
                      askedByViewer(c, viewer),
                  },
                }
              : {}),
            closed: c.ask.closed,
          },
        }
      : {}),
    ...(c.notified?.length && !outsider(viewer) && viewer.userId !== null
      ? {
          notified: c.notified.map((m) => ({
            key: m.key,
            name: agentName(
              currentName(m, users),
              m.owner ? users.users.get(m.owner) : undefined,
              viewer,
              users.clash,
            ),
            ...(m.owner
              ? {
                  for: forLine(
                    users.users.get(m.owner),
                    faceViewer(viewer),
                    users.clash,
                  ),
                }
              : {}),
            ...identityFace(
              { ...m, name: currentName(m, users) },
              viewer,
              users,
            ),
            delivery: m.state as MentionDelivery,
          })),
        }
      : {}),
    ...(c.mentions?.length
      ? {
          mentions: c.mentions.map((m, i) => ({
            key: m.key,
            name: shown[i] ?? m.name,
            ...(m.owner
              ? {
                  for: forLine(
                    users.users.get(m.owner),
                    faceViewer(viewer),
                    users.clash,
                  ),
                }
              : {}),
            ...identityFace(
              { ...m, name: currentName(m, users) },
              viewer,
              users,
            ),
            // #2004: outsiders learn nothing of an agent's state.
            ...(outsider(viewer) || viewer.userId === null
              ? {}
              : { delivery: m.state as MentionDelivery }),
          })),
        }
      : {}),
  };
};

async function commentView(
  env: Env,
  c: StoredComment,
  viewer: CommentViewer,
): Promise<Comment> {
  const ids = new Set<string>();
  userIds(c, ids);
  return commentOf(
    c,
    viewer,
    await ctxFor(env, ids, hasAgent(c), { comments: [c] }),
  );
}

// -------------------------------------------------------------------- reads

/** Threads by newest activity (at most 500, 200 replies each) and the open count. */
export async function listComments(
  env: Env,
  artifactId: string,
  status: CommentStatus | "all",
  viewer: CommentViewer,
): Promise<CommentList> {
  // A full read repairs the asks index (#1623); never fails the read. The rows
  // are read first, so the threads are never older than the rows they are
  // compared with.
  const rows = status === "all" ? await askRows(env, artifactId) : null;
  const r = await call(() => stub(env, artifactId).commentsList(status));
  if (rows) await reconcileAsks(env, artifactId, r.threads, r.truncated, rows);
  return {
    threads: await threadViews(env, artifactId, r.threads, viewer),
    open: r.open,
    truncated: r.truncated,
  };
}

// ------------------------------------------------------------------- writes

/** Where a new comment's `comment` notice goes: after the response when there is a ctx. */
export type Announce = {
  /** The artifact's current version, named in the notice. */
  version: number;
  ctx?: Pick<ExecutionContext, "waitUntil">;
};

/** Followers hear of a new comment (once, never the author's own agents); never throws. */
const announce = (
  env: Env,
  artifactId: string,
  who: CommentWho,
  after: Announce | undefined,
  /** The comment's mentions and ask: those agents already heard of it. */
  r?: Resolved,
) =>
  after
    ? inBackground(
        after.ctx,
        notifyCommented(
          env,
          artifactId,
          after.version,
          who.kind === "user" ? who.id : null,
          Date.now(),
          new Set((r?.agents ?? []).map((x) => addressKey(x.agent.address))),
        ),
      )
    : undefined;

/** Emails the people a new thread or reply concerns (#1467), after the response; never throws. */
const emailPeople = (
  env: Env,
  artifactId: string,
  threadId: string,
  comment: StoredComment | undefined,
  reply: boolean,
  after: Announce | undefined,
) =>
  after && comment
    ? inBackground(
        after.ctx,
        emailCommentRecipients(env, { artifactId, threadId, comment, reply }),
      )
    : undefined;

/** What a comment may carry besides its body (#1535). `ask` is for the MCP tool: no REST body takes it. */
export type CommentExtras = {
  mentions?: KeyRef[];
  ask?: AskInput;
  /** A reply addressed to the thread root's ask author (#1614): see addReply. Alone: no mentions or ask. */
  toAsker?: boolean;
};

/** Who may mention and ask. `moderator`: the owner or an editor. */
export type ExtrasOpts = {
  moderator?: boolean;
  /** Followers hear of the new comment (#682); absent: nobody is told. */
  after?: Announce;
};

type Resolved = {
  extras: NewExtras | undefined;
  /** Every agent the comment reaches, once, with why (ask beats mention). */
  agents: { agent: RosterAgent; kind: CommentNoticeKind }[];
  /** The agents to make follow: mentioned, resolved from the viewer's own running agents. */
  follow: RosterAgent[];
  mentions: string[];
  /** What the stored mention rows are: plain mentions, or the agents a reply to the asker reached (#1614). */
  mentionKind: "mention" | "asker";
  participants: StoredParticipant[];
};

const participantOf = (a: RosterAgent): StoredParticipant => ({
  ...storedAgent(a),
  namespace: a.address.namespace,
});

/**
 * #1900: an agent that comments joins the thread, but only one the server
 * identified (#1822): that proof gives the exact bus address. An agent with no
 * identity (a legacy token, an unlinked grant) cannot be told apart from the
 * member's other agents, so it does not join by commenting.
 */
async function authorParticipant(
  artifactId: string,
  who: CommentWho,
): Promise<StoredParticipant[]> {
  const id = who.kind === "user" ? who.agent?.identity : undefined;
  if (who.kind !== "user" || !id) return [];
  const address = { namespace: id.namespace, name: id.name };
  if (!BusAddressSchema.safeParse(address).success) return [];
  return [
    {
      kind: "agent",
      key: await agentKey(artifactId, who.id, address),
      name: id.name,
      owner: who.id,
      namespace: id.namespace,
      identity: { identityId: id.identityId, kind: id.kind },
    },
  ];
}

/**
 * #1968: the agent that published the version a page-wide thread starts on, as
 * a roster agent, or null. Only a linked one counts: the version carries the
 * server-set identity (#1822) of the bus session that proved itself on the
 * publisher's own hub, so the address is exact and never another member's.
 * Null for a web publish, an unlinked agent, a publisher who can no longer
 * read the artifact or hold a bus, and the author's own agent.
 */
async function pagePublisher(
  env: Env,
  a: Pick<ArtifactRow, "id" | "currentVersion">,
  who: CommentWho,
): Promise<RosterAgent | null> {
  const row = await stmt(
    env.DB,
    "select agent_identity as identity, created_by as userId from versions where artifact_id = ? and version = ?",
  )
    .bind(a.id, a.currentVersion)
    .first<{ identity: string | null; userId: string }>();
  if (!row?.identity) return null;
  let id: { identityId?: unknown; namespace?: unknown; name?: unknown };
  try {
    id = JSON.parse(row.identity);
  } catch {
    return null;
  }
  const address = BusAddressSchema.safeParse({
    namespace: id.namespace,
    name: id.name,
  });
  if (!address.success) return null;
  if (who.kind === "user" && who.agent?.identity?.identityId === id.identityId)
    return null;
  const user = await getUser(env, row.userId);
  if (
    !user ||
    !canConnect(user) ||
    !(await accessLevel(env, callerOf(user), a.id))
  )
    return null;
  return {
    key: await agentKey(a.id, row.userId, address.data),
    name: address.data.name,
    online: false,
    userId: row.userId,
    address: address.data,
  };
}

/** The key of a roster agent (comment-agents.ts agentKey). */
const AGENT_KEY = /^agent:[0-9a-f]{32}$/;

const unknownKey = (key: string) =>
  new ApiError("bad_request", `Unknown agent or person: ${key}`);

/**
 * Checks and resolves mentions and ask. 403 forbidden unless the
 * caller is the owner or an editor (mentions) or a signed-in person
 * (ask); 400 bad_request for a key that is no agent following the artifact
 * (mentions) or no such agent or person who can read it (ask).
 */
async function resolveExtras(
  env: Env,
  artifactId: string,
  who: CommentWho,
  x: CommentExtras,
  opts: ExtrasOpts,
): Promise<Resolved> {
  const none: Resolved = {
    extras: undefined,
    agents: [],
    follow: [],
    mentions: [],
    mentionKind: "mention",
    participants: [],
  };
  const wantsTargets = (x.mentions?.length ?? 0) > 0;
  if (!wantsTargets && !x.ask) return none;
  // An ask notifies agents too: the same rule as mentions.
  if ((wantsTargets || x.ask) && !opts.moderator)
    throw new ApiError(
      "forbidden",
      "Only the owner and editors can mention or ask. Drop it, or post a plain comment.",
    );
  if (x.ask && who.kind !== "user")
    throw new ApiError("forbidden", "Sign in to ask a question");
  const parsed = x.ask ? AskInputSchema.safeParse(x.ask) : null;
  if (parsed && !parsed.success)
    throw new ApiError("bad_request", "Invalid ask", parsed.error.issues);
  const askIn = parsed?.success ? parsed.data : undefined;
  const viewerId = who.kind === "user" ? who.id : null;
  const roster = await agentRoster(env, artifactId, viewerId, false);
  // The viewer's own running agents (#1535) are keyed by a hash of their
  // address, so a key the follows do not hold can only be resolved by reading
  // the viewer's hub. That read happens once per POST (memoised), only for a
  // key shaped like an agent key that the follows do not hold: a mention of a
  // follower, an ask to a person or a junk key costs D1 alone. busView bounds
  // the read at BUS_HUB_TIMEOUT_MS (a stalled hub then reads as an unknown
  // key). It sits OUTSIDE the POST's NOTICE_BUDGET_MS, so the worst case is
  // about that bound plus the budget (about 4.5 s), and it runs before the
  // rate-limit take: a thread's take is tied to the anchor check and a reply's
  // sits in the DO write, so moving it ahead of this read is not a small change.
  // Only the viewer's own agents, never another member's.
  let own: Promise<RosterAgent[]> | undefined;
  /** Keys resolved from the viewer's own running agents: not in the follows. */
  const viaOwn = new Set<string>();
  const find = async (key: string): Promise<RosterAgent | undefined> => {
    const a = roster.find((r) => r.key === key);
    if (a || !viewerId || !AGENT_KEY.test(key)) return a;
    own ??= viewerRosterAgents(env, artifactId, viewerId);
    const found = (await own).find((r) => r.key === key);
    if (found) viaOwn.add(key);
    return found;
  };
  const agentOf = async (key: string): Promise<RosterAgent> => {
    const a = await find(key);
    if (!a) throw unknownKey(key);
    return a;
  };
  const mentioned: RosterAgent[] = [];
  for (const key of new Set((x.mentions ?? []).map((m) => m.key)))
    mentioned.push(await agentOf(key));
  let ask: NewExtras["ask"];
  const asked: RosterAgent[] = [];
  if (askIn) {
    const to: StoredParty[] = [];
    for (const { key } of askIn.to) {
      if (to.some((p) => p.key === key)) continue;
      const a = await find(key);
      if (a) {
        to.push(storedAgent(a));
        asked.push(a);
        continue;
      }
      // A person who can read the artifact now.
      const user = isId(key) ? await getUser(env, key) : null;
      if (!user || !(await accessLevel(env, callerOf(user), artifactId)))
        throw unknownKey(key);
      to.push({ kind: "user", key: user.id });
    }
    // #2381: who decides. Default: the asker's own user (nothing stored). Naming
    // someone else needs a member who can edit the page, and never on an ask
    // that names an action; the asker's own user stays on the ask to take it back.
    let decider: string | undefined;
    const askerId = who.kind === "user" ? who.id : "";
    if (askIn.decider && askIn.decider.key !== askerId) {
      if (askIn.options.some((o) => o.action))
        throw new ApiError(
          "bad_request",
          "An ask that names an action is decided by you: drop `decider`",
        );
      const dk = askIn.decider.key;
      const du = isId(dk) ? await getUser(env, dk) : null;
      const dl = du ? await accessLevel(env, callerOf(du), artifactId) : null;
      if (!du || !dl || !meetsLevel(dl.level, "editor"))
        throw new ApiError(
          "bad_request",
          "A decider must be a member who can edit this page",
        );
      decider = du.id;
      const addressed = (id: string) => to.some((p) => addresseeOf(p) === id);
      if (!addressed(du.id)) to.push({ kind: "user", key: du.id });
      if (!addressed(askerId)) to.push({ kind: "user", key: askerId });
      if (to.length > ASK_TO_MAX)
        throw new ApiError(
          "bad_request",
          `An ask names at most ${ASK_TO_MAX} people, the decider and you included`,
        );
    }
    // #2263: the server decides, from the actions the options name and the
    // addressees' switches. Whatever a client sent as `confirm` was stripped by
    // the schema; an edit never touches the stored mark.
    const confirm = await confirmFor(env, addressees(to), askIn.options);
    ask = {
      question: askIn.question,
      options: askIn.options,
      ...(askIn.recommended ? { recommended: askIn.recommended } : {}),
      to,
      ...(confirm ? { confirm } : {}),
      ...(decider ? { decider } : {}),
    };
  }
  const agents = new Map<string, Resolved["agents"][number]>();
  for (const a of mentioned) agents.set(a.key, { agent: a, kind: "mention" });
  for (const a of asked) agents.set(a.key, { agent: a, kind: "ask" });
  // A mention makes an agent follow (#1535); an ask alone does
  // not. Only one the follows did not hold: another member's unfollow is never undone.
  const toFollow = mentioned.filter((x) => viaOwn.has(x.key));
  return {
    follow: [...new Map(toFollow.map((x) => [x.key, x])).values()],
    extras: {
      ...(ask ? { ask } : {}),
      ...(mentioned.length
        ? { mentions: mentioned.map((m) => storedAgent(m)) }
        : {}),
    },
    agents: [...agents.values()],
    mentions: mentioned.map((m) => m.key),
    mentionKind: "mention",
    // #2035: an @-mention or an ask also puts back an agent a person removed.
    participants: [...agents.values()].map((x) => ({
      ...participantOf(x.agent),
      readd: true as const,
    })),
  };
}

/**
 * How a notice's outcome reads on the comment. A held notice waits for the
 * machine ("queued"). A dropped one found no session and reads "gone".
 */
const stateOf = (out: DeliveryState): "delivered" | "queued" | "gone" =>
  out === "delivered" ? "delivered" : out === "held" ? "queued" : "gone";

/** The most a comment POST waits, in total, for its notices to reach their hubs. */
export const NOTICE_BUDGET_MS = 2500;

/** The mentioned agent follows the artifact; never throws (a follow_limit or a lapsed member is logged). */
async function followMentioned(
  env: Env,
  artifactId: string,
  agent: RosterAgent,
): Promise<void> {
  try {
    await follow(env, agent.userId, agent.address, artifactId);
  } catch (e) {
    logInfo("comment_mention_follow_failed", {
      artifactId,
      code: e instanceof ApiError ? e.code : "error",
    });
  }
}

/**
 * Sends the notices of a written comment and records how each mention went. Returns the comment as then stored.
 */
async function deliver(
  env: Env,
  a: Pick<ArtifactRow, "id" | "currentVersion">,
  threadId: string,
  c: StoredComment,
  r: Resolved,
): Promise<StoredComment> {
  if (r.agents.length === 0) return c;
  const version = Math.max(1, a.currentVersion);
  const outcome = new Map<string, DeliveryState>();
  // Concurrent, and the POST waits NOTICE_BUDGET_MS at most in total: a
  // stalled hub reads "dropped" (its notice may still arrive).
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<DeliveryState>((res) => {
    timer = setTimeout(() => res("dropped"), NOTICE_BUDGET_MS);
  });
  try {
    // A mentioned agent of the viewer's that did not follow now
    // follows (#1535), beside the notice and under the same budget. Best
    // effort: a failure is logged and changes neither the notice nor the comment.
    const follows = r.follow.map((agent) =>
      Promise.race([followMentioned(env, a.id, agent), late]),
    );
    const [outs] = await Promise.all([
      Promise.all(
        r.agents.map(({ agent, kind }) =>
          Promise.race([
            notifyAgent(
              env,
              a.id,
              version,
              threadId,
              c.id,
              kind,
              agent,
              // Only a comment a person typed, to an agent of that same person.
              isTyped(c.author) && c.author.ref === agent.userId,
            ),
            late,
          ]),
        ),
      ),
      Promise.all(follows),
    ]);
    r.agents.forEach(({ agent }, i) => {
      outcome.set(agent.key, outs[i] ?? "dropped");
    });
  } finally {
    clearTimeout(timer);
  }
  const states = r.mentions.map((key) => ({
    kind: r.mentionKind,
    key,
    state: stateOf(outcome.get(key) ?? "dropped"),
  }));
  if (states.length === 0) return c;
  try {
    return await call(() =>
      stub(env, a.id).commentsTargetStates({
        threadId,
        commentId: c.id,
        states,
      }),
    );
  } catch (e) {
    // Deleted between the write and here: the comment was created and the
    // notices went out, so the POST stands (a retry would notify twice).
    if (e instanceof ApiError && e.code === "not_found") {
      logInfo("comment_deleted_before_delivery_record");
      return c;
    }
    throw e;
  }
}

/**
 * #1890: `r` with the bus identity of each mentioned or asked agent,
 * read from its OWNER's hub (the roster entry's userId, validated by
 * resolveExtras, never client input). All lookups run in parallel, each bounded
 * by LINK_LOOKUP_MS, so the whole costs about one bound. A miss, a slow or a
 * failing hub leaves that party without an identity; this never throws. Run
 * after the rate-limit charge where there is one before the write.
 */
async function withIdentities(env: Env, r: Resolved): Promise<Resolved> {
  const x = r.extras;
  if (!x || r.agents.length === 0) return r;
  const byKey = new Map(r.agents.map((e) => [e.agent.key, e.agent]));
  const keys = [...byKey.keys()];
  const found = await Promise.all(
    keys.map((k) => {
      const a = byKey.get(k) as RosterAgent;
      return agentIdentityOf(env, a.userId, a.address);
    }),
  );
  const ids = new Map(keys.map((k, i) => [k, found[i]]));
  const put = <T extends StoredAgent>(p: T): T => {
    const identity = ids.get(p.key);
    return identity ? { ...p, identity } : p;
  };
  return {
    ...r,
    participants: r.participants.map(put),
    extras: {
      ...x,
      ...(x.mentions ? { mentions: x.mentions.map(put) } : {}),
      ...(x.ask
        ? {
            ask: {
              ...x.ask,
              to: x.ask.to.map((p) => (p.kind === "agent" ? put(p) : p)),
            },
          }
        : {}),
    },
  };
}

/** A new thread: `raw` is the anchor as posted, `body` the first comment. 201 Thread. */
export async function addThread(
  env: Env,
  a: Pick<ArtifactRow, "id" | "format" | "currentVersion">,
  who: CommentWho,
  viewer: CommentViewer,
  raw: { anchor: unknown; body: unknown } & CommentExtras,
  opts: ExtrasOpts = {},
): Promise<Thread> {
  const body = checkBody(raw.body);
  const r0 = await resolveExtras(env, a.id, who, raw, opts);
  // The limit comes before any file is read, and a refused quote counts.
  let taken = false;
  const take = async () => {
    taken = true;
    await call(() => stub(env, a.id).commentsTake(rateKeyOf(who)));
  };
  const { anchor, version } = await checkAnchor(env, a, raw.anchor, take);
  if (!taken) await take();
  const page =
    // Members only (#1968): not a signed-out visitor, a guest or a guest-role member.
    anchor.kind === "note" &&
    r0.agents.length === 0 &&
    who.kind === "user" &&
    !outsider(viewer)
      ? await pagePublisher(env, a, who)
      : null;
  if (page) {
    r0.extras = { ...r0.extras, mentions: [storedAgent(page)] };
    r0.agents.push({ agent: page, kind: "mention" });
    r0.mentions.push(page.key);
  }
  // After the rate-limit charge, and after the page mention is added: a
  // refused post costs no hub reads, and the page's agent gets its identity too.
  const r = await withIdentities(env, r0);
  const pageIdentity = page
    ? r.extras?.mentions?.find((m) => m.key === page.key)?.identity
    : undefined;
  const participants = [
    ...r.participants,
    ...(page
      ? [
          {
            ...participantOf(page),
            page: true as const,
            ...(pageIdentity ? { identity: pageIdentity } : {}),
          },
        ]
      : []),
    ...(await authorParticipant(a.id, who)),
  ];
  const t = await call(() =>
    stub(env, a.id).commentsAdd({
      actor: actorOf(who),
      rate: rateKeyOf(who),
      counted: true,
      anchor,
      version,
      body,
      ...(r.extras ? { extras: r.extras } : {}),
      ...(participants.length ? { participants } : {}),
    }),
  );
  const root = t.comments[0];
  if (root?.ask) await indexAsk(env, a.id, t.id, root.id, root.ask.to);
  if (root && r.agents.length > 0) {
    const sent = await deliver(env, a, t.id, root, r);
    t.comments[0] = sent;
  }
  await announce(env, a.id, who, opts.after, r);
  await emailPeople(env, a.id, t.id, root, false, opts.after);
  return (await threadViews(env, a.id, [t], viewer))[0] as Thread;
}

/**
 * #2224: the bus address of the agent that posted the ask at the thread's root
 * (`author`), or null: a person's ask, or an agent with no verified bus
 * identity (a notice then reaches nobody). It is the thread participant the
 * author recorded at write time (same verified identity), at the address its
 * owner's hub reports for that identity now (fresh read, never the names
 * cache). Anything less than that answer gives null. Never a follower or the
 * member's other agents.
 */
async function askingAddress(
  env: Env,
  artifactId: string,
  threadId: string,
  author: StoredActor,
): Promise<AskerAddress | null> {
  const id = author.kind === "user" ? author.agent?.identity : undefined;
  if (author.kind !== "user" || !id) return null;
  const rows = await call(() =>
    stub(env, artifactId).commentsParticipants({ threadIds: [threadId] }),
  );
  const row = rows
    .flatMap(([, ps]) => ps)
    .find(
      (p) => p.owner === author.ref && p.identity?.identityId === id.identityId,
    );
  if (!row) return null;
  // Fail closed: a fresh, uncached read of the owner's own hub must give the
  // identity's current name, and that name must still be this identity's. A
  // miss, a timeout, an error or another agent holding the name sends nothing.
  const none = (reason: string): null => {
    logInfo("ask_asker_unresolved", { artifactId, threadId, reason });
    return null;
  };
  const current = (await agentNamesOf(env, row.owner, [id.identityId])).get(
    id.identityId,
  );
  if (!current) return none("no_current_name");
  const address = { namespace: row.namespace, name: current };
  if (!BusAddressSchema.safeParse(address).success) return none("bad_address");
  const at = await agentIdentityOf(env, row.owner, address);
  if (at?.identityId !== id.identityId) return none("name_not_theirs");
  return { ...address, identityId: id.identityId };
}

/**
 * A reply to the thread root's ask author (#1614). 400 not_an_ask unless the
 * root carries an ask and its author is an agent (a person's ask has no agent
 * to tell). The only addressee is that author's agents: the same target as
 * ask_answered (askerRoster: that exact agent by its verified bus address, #2224;
 * an author with no bus address gets nobody). It can reach no other agent. The notice is fixed text with the ids.
 */
async function resolveToAsker(
  env: Env,
  artifactId: string,
  threadId: string,
): Promise<Resolved> {
  const t = await call(() => stub(env, artifactId).commentsGet(threadId));
  const root = t.comments[0];
  if (!root?.ask || root.author.kind !== "user" || !root.author.agent)
    throw new ApiError(
      "not_an_ask",
      "This thread has no question from an agent to reply to",
    );
  const to = await askerRoster(
    env,
    artifactId,
    root.author.ref,
    await askingAddress(env, artifactId, threadId, root.author),
  );
  return {
    extras: to.length ? { asker: to.map((a) => storedAgent(a)) } : undefined,
    agents: to.map((agent) => ({ agent, kind: "asker" as const })),
    follow: [],
    mentions: to.map((a) => a.key),
    mentionKind: "asker",
    // The asker's agents are not named one by one: the asking agent joins by its own comment.
    participants: [],
  };
}

/**
 * #1900: a reply from a person (a signed-in member typing or calling without an
 * agent, or a guest) tells the thread's participant agents, except the ones
 * this same comment already reached (mention, ask, reply to the
 * asker). An agent's reply never does this. The bound (a cap per thread, none once resolved) is spent in the DO; an agent
 * whose member lost access or cannot hold a bus is skipped and its spend given
 * back. A notice goes only to the exact participant, never its member's other
 * agents. #2035: an agent a person removed from the thread is skipped, and
 * the others are recorded on the reply with how each notice went. Returns the
 * comment as then stored. Never throws.
 */
async function threadReply(
  env: Env,
  a: Pick<ArtifactRow, "id" | "currentVersion">,
  threadId: string,
  c: StoredComment,
  r: Resolved,
  viewer: CommentViewer,
): Promise<StoredComment> {
  // Members only (#1900, #1968): never an agent, a signed-out visitor, a guest
  // or a guest-role member.
  if (c.author.kind !== "user" || c.author.agent || outsider(viewer)) return c;
  let out = c;
  try {
    const due = await call(() =>
      stub(env, a.id).commentsThreadReplyTake({
        threadId,
        at: c.createdAt,
        exclude: r.agents.map((x) => x.agent.key),
        // A reply that @-mentions someone is for them (#1968).
        skipPage: r.agents.length > 0,
      }),
    );
    if (due.length === 0) return c;
    const reached: RosterAgent[] = [];
    const users = new Map<string, boolean>();
    for (const p of due) {
      let ok = users.get(p.owner);
      if (ok === undefined) {
        const user = await getUser(env, p.owner);
        ok =
          !!user &&
          canConnect(user) &&
          !!(await accessLevel(env, callerOf(user), a.id));
        users.set(p.owner, ok);
      }
      if (ok)
        reached.push({
          key: p.key,
          name: p.name,
          online: false,
          userId: p.owner,
          address: { namespace: p.namespace, name: p.name },
        });
    }
    // The rows exist (queued) before any notice goes out, as a mention's do, so
    // a daemon's ack that beats the write below still finds its row to settle.
    await call(() =>
      stub(env, a.id).commentsReplyTargets({
        threadId,
        commentId: c.id,
        targets: reached.map((agent) => ({
          p: due.find((d) => d.key === agent.key) as StoredParticipant,
          state: "queued",
        })),
      }),
    ).catch(() => c);
    const version = Math.max(1, a.currentVersion);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<DeliveryState>((res) => {
      timer = setTimeout(() => res("dropped"), NOTICE_BUDGET_MS);
    });
    let outs: DeliveryState[];
    try {
      outs = await Promise.all(
        reached.map((agent) =>
          Promise.race([
            notifyAgent(
              env,
              a.id,
              version,
              threadId,
              c.id,
              "thread_reply",
              agent,
              isTyped(c.author) && c.author.ref === agent.userId,
            ),
            late,
          ]),
        ),
      );
    } finally {
      clearTimeout(timer);
    }
    out = await call(() =>
      stub(env, a.id).commentsTargetStates({
        threadId,
        commentId: c.id,
        states: reached.map((agent, i) => ({
          kind: "reply" as const,
          key: agent.key,
          state: stateOf(outs[i] ?? "dropped"),
        })),
      }),
    ).catch(() => c);
    // Spent for a notice that went out or is held; given back for the rest.
    const back = [
      ...due.filter((p) => !reached.some((x) => x.key === p.key)),
      ...reached.filter((_, i) => outs[i] === "dropped"),
    ].map((p) => p.key);
    if (back.length > 0)
      await call(() =>
        stub(env, a.id).commentsThreadReplyRefund({
          threadId,
          at: c.createdAt,
          keys: back,
        }),
      ).catch(() => undefined);
  } catch (e) {
    logInfo("comment_thread_reply_failed", {
      artifactId: a.id,
      code: e instanceof ApiError ? e.code : "error",
    });
  }
  return out;
}

/** A reply. It does not reopen the thread. */
export async function addReply(
  env: Env,
  artifactId: string,
  threadId: string,
  who: CommentWho,
  viewer: CommentViewer,
  body: unknown,
  extras: CommentExtras = {},
  opts: ExtrasOpts = {},
): Promise<Comment> {
  const text = checkBody(body);
  let r: Resolved;
  if (extras.toAsker) {
    if ((extras.mentions?.length ?? 0) > 0 || extras.ask !== undefined)
      throw new ApiError(
        "bad_request",
        "toAsker cannot be combined with mentions or ask",
      );
    r = await resolveToAsker(env, artifactId, threadId);
  } else {
    // The reply's rate-limit charge is inside the DO write, so the lookups
    // come first here (parallel, bounded: about one LINK_LOOKUP_MS).
    r = await withIdentities(
      env,
      await resolveExtras(env, artifactId, who, extras, opts),
    );
  }
  const participants = [
    ...r.participants,
    ...(await authorParticipant(artifactId, who)),
  ];
  let c = await call(() =>
    stub(env, artifactId).commentsReply({
      threadId,
      actor: actorOf(who),
      rate: rateKeyOf(who),
      body: text,
      ...(r.extras ? { extras: r.extras } : {}),
      ...(participants.length ? { participants } : {}),
    }),
  );
  // The thread's bound (one notice per window, a cap in all) left the reply
  // without its mention rows: nobody is told, and the usual follower notice
  // (its own limits) is the only one.
  if (extras.toAsker && !c.mentions?.length)
    r = { ...r, agents: [], mentions: [] };
  if (c.ask) await indexAsk(env, artifactId, threadId, c.id, c.ask.to);
  const row = await stmt(
    env.DB,
    "select current_version as v from artifacts where id = ?",
  )
    .bind(artifactId)
    .first<{ v: number }>();
  const a = { id: artifactId, currentVersion: row?.v ?? 1 };
  // #1900: a person's reply also tells the thread's other agents, once each.
  c = await threadReply(env, a, threadId, c, r, viewer);
  if (r.agents.length === 0) {
    await announce(env, artifactId, who, opts.after, r);
    await emailPeople(env, artifactId, threadId, c, true, opts.after);
    return commentView(env, c, viewer);
  }
  const sent = await deliver(env, a, threadId, c, r);
  // The bound is spent when a notice goes out or is held; a reply whose agents
  // all read "gone" (no session, or a stalled hub) gives it back (#1614).
  if (
    extras.toAsker &&
    sent.mentions?.length &&
    sent.mentions.every((m) => m.state === "gone")
  )
    await call(() =>
      stub(env, artifactId).commentsAskerRefund({ threadId, at: c.createdAt }),
    ).catch(() => undefined);
  await announce(env, artifactId, who, opts.after, r);
  await emailPeople(env, artifactId, threadId, sent, true, opts.after);
  return commentView(env, sent, viewer);
}

/** How the pick reached the server (#2263): only a browser session may carry a passkey. */
export type PickAuth = { interactive: boolean; assertion?: unknown };

/** The stored ask of a comment and its thread's status, or 404. */
async function storedAsk(
  env: Env,
  artifactId: string,
  threadId: string,
  commentId: string,
) {
  const t = await call(() => stub(env, artifactId).commentsGet(threadId));
  const c = t.comments.find((x) => x.id === commentId);
  const ask = c?.ask;
  if (!c || !ask) throw new ApiError("not_found", "Not found");
  return { ask, status: t.status, author: c.author.ref };
}

/** Whether `who` is one of the people the ask was put to (as the DO decides). */
const isAsked = (
  ask: { to: StoredParty[]; decider?: string },
  who: CommentWho,
  author: string,
): boolean =>
  who.kind === "user" &&
  (ask.to.some((p) => addresseeOf(p) === who.id) ||
    (ask.decider ?? author) === who.id);

/** #2381: the ask's decider: the person the asker named, else the asker's own user. */
const deciderOf = (ask: { decider?: string }, author: string): string =>
  ask.decider ?? author;

/**
 * #2263: a WebAuthn challenge for picking `optionId` on a confirm ask:
 * 403 passkey_required for anything but a browser session (a token or MCP
 * grant can never carry a passkey), 403 forbidden unless asked, 404 without an
 * ask, 400 for an ask that needs no passkey or an unknown option, 409
 * conflict once closed, 409 already_answered (that option is the answer already; another option is a change and needs a fresh assertion), then the passkey rules
 * (no_passkey, passkey_cooling) and the challenge budget (429).
 */
export async function answerChallenge(
  env: Env,
  artifactId: string,
  threadId: string,
  commentId: string,
  who: CommentWho,
  optionId: string,
  interactive: boolean,
) {
  const { ask, status, author } = await storedAsk(
    env,
    artifactId,
    threadId,
    commentId,
  );
  if (!interactive || who.kind !== "user")
    throw new ApiError(
      "passkey_required",
      "Only the web app can use a passkey",
    );
  if (!isAsked(ask, who, author))
    throw new ApiError("forbidden", "Only the people asked can answer");
  if (ask.confirm !== "passkey")
    throw new ApiError("bad_request", "This ask does not need a passkey");
  if (status === "resolved")
    throw new ApiError("conflict", "This ask is closed");
  if (!ask.options.some((o) => o.id === optionId))
    throw new ApiError("bad_request", "Unknown option");
  if (ask.answer?.optionId === optionId)
    throw new ApiError(
      "already_answered",
      "This ask is answered with that option",
    );
  return pickChallenge(env, who.id, artifactId, commentId, optionId);
}

/**
 * Answers an ask (#1535): 404 without one, 403 unless the caller is asked,
 * 409 once the thread is resolved, 400 for an option the ask lacks. The
 * answer may change until then. `who` is the caller as an author (a guest is
 * never asked).
 *
 * #2263: on an ask marked `confirm: "passkey"` the pick is one answer and
 * needs a verified passkey assertion for a challenge issued for this exact
 * (artifact, comment, option, member): 403 passkey_required without one, and
 * always for a token or MCP grant; 409 already_answered; then the challenge
 * rules of verifyPick (410 challenge_expired, 400 passkey_failed).
 */
export async function answerAsk(
  env: Env,
  artifactId: string,
  threadId: string,
  commentId: string,
  who: CommentWho,
  viewer: CommentViewer,
  optionId: string,
  /** The artifact's current version and the request's ctx: the asker's agents hear of the answer (#1535), after the response. */
  after: Announce | undefined,
  pick: PickAuth,
  /** #2381: the caller may edit the page (the decider must), and is a guest-role member. */
  caps: { canDecide: boolean; guest: boolean } = {
    canDecide: true,
    guest: false,
  },
): Promise<Comment> {
  const { ask, status, author } = await storedAsk(
    env,
    artifactId,
    threadId,
    commentId,
  );
  let verified: "passkey" | undefined;
  // Strangers, closed asks and unknown options fall through to the DO's own
  // refusals (forbidden, conflict, bad_request) without touching a challenge.
  if (
    ask.confirm === "passkey" &&
    isAsked(ask, who, author) &&
    who.kind === "user" &&
    deciderOf(ask, author) === who.id &&
    status !== "resolved" &&
    ask.options.some((o) => o.id === optionId)
  ) {
    if (!pick.interactive || who.kind !== "user")
      throw new ApiError(
        "passkey_required",
        "This pick needs your passkey, in the web app",
      );
    if (ask.answer?.optionId === optionId)
      throw new ApiError(
        "already_answered",
        "This ask is answered with that option",
      );
    if (pick.assertion === undefined || pick.assertion === null)
      throw new ApiError("passkey_required", "This pick needs your passkey");
    await verifyPick(
      env,
      who.id,
      artifactId,
      commentId,
      optionId,
      pick.assertion,
    );
    verified = "passkey";
  }
  const {
    comment: c,
    unchanged,
    decided,
  } = await call(() =>
    stub(env, artifactId).commentsAnswer({
      threadId,
      commentId,
      by: actorOf(who),
      optionId,
      rate: rateKeyOf(who),
      ...(verified ? { verified } : {}),
      canDecide: caps.canDecide,
      guest: caps.guest,
    }),
  );
  // Only the decision is "answered"; a weigh-in is input (#2381).
  if (decided) await indexAnswered(env, artifactId, commentId);
  // The answer is stored: the asker's following agents hear of it, in the
  // background, and a failure never fails the answer (inBackground catches).
  if (after && !unchanged && c.author.kind === "user")
    await inBackground(
      after.ctx,
      notifyAnswered(
        env,
        artifactId,
        Math.max(1, after.version),
        threadId,
        commentId,
        c.author.ref,
        await askingAddress(env, artifactId, threadId, c.author),
        // Only an answer the asker picked themselves in the web app.
        decided &&
          c.ask?.answer !== undefined &&
          isTyped(c.ask.answer.by) &&
          c.ask.answer.by.ref === c.author.ref,
      ),
    );
  return commentView(env, c, viewer);
}

/**
 * #2381: the asker's own user takes the decision back from the person the
 * asking agent named: 404 without an ask, 403 unless the caller is the ask's
 * own user, 409 once closed or decided, 400 when they decide already.
 */
export async function takeBackAsk(
  env: Env,
  artifactId: string,
  threadId: string,
  commentId: string,
  who: CommentWho,
  viewer: CommentViewer,
): Promise<Comment> {
  if (who.kind !== "user")
    throw new ApiError("forbidden", "Only the person who asked can do this");
  const c = await call(() =>
    stub(env, artifactId).commentsTakeBack({
      threadId,
      commentId,
      by: actorOf(who),
      rate: rateKeyOf(who),
    }),
  );
  return commentView(env, c, viewer);
}

/**
 * The agents that can be mentioned or asked on the artifact. A
 * guest or signed-out viewer gets no machine and no last-active time, only the
 * state (a signed-out viewer never reaches here: the route lists none).
 */
export async function artifactAgents(
  env: Env,
  artifactId: string,
  viewerId: string | null,
  guest = false,
): Promise<ArtifactAgent[]> {
  const masked = guest || viewerId === null;
  return (await agentRoster(env, artifactId, viewerId, true, true)).map(
    ({ key, name, online, state, lastActiveAt, machine, owner }) => ({
      key,
      name,
      online,
      state,
      lastActiveAt: masked ? null : lastActiveAt,
      machine: masked ? null : machine,
      owner,
    }),
  );
}

/** Resolve or reopen. */
export async function setStatus(
  env: Env,
  artifactId: string,
  threadId: string,
  who: CommentWho,
  viewer: CommentViewer,
  status: CommentStatus,
): Promise<Thread> {
  const t = await call(() =>
    stub(env, artifactId).commentsStatus({
      threadId,
      status,
      actor: actorOf(who),
      rate: rateKeyOf(who),
    }),
  );
  await indexStatus(env, artifactId, threadId, status);
  return (await threadViews(env, artifactId, [t], viewer))[0] as Thread;
}

/**
 * #2035: stops (or, with `removed` false, resumes) replies in a thread
 * reaching one of its agents. Only the agent's own person or the artifact's
 * owner may; a guest, a signed-out visitor or a restricted member never (404
 * for an agent they cannot see). 404 when the thread has no such agent.
 */
export async function setThreadAgent(
  env: Env,
  artifactId: string,
  threadId: string,
  key: string,
  viewer: CommentViewer,
  removed: boolean,
  /** The request's execution context: the hub withdrawal runs after the response (a hung hub must not delay the ×). */
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  if (outsider(viewer) || viewer.userId === null)
    throw new ApiError("forbidden", "Only members can change who is notified");
  const rows = new Map(
    await call(() =>
      stub(env, artifactId).commentsParticipants({ threadIds: [threadId] }),
    ),
  );
  const p = rows.get(threadId)?.find((x) => x.key === key);
  if (!p) throw new ApiError("not_found", "Not found");
  if (!(viewer.owner === true || viewer.userId === p.owner))
    throw new ApiError(
      "forbidden",
      "Only the person whose agent it is, or the artifact's owner, can change this",
    );
  await call(() =>
    stub(env, artifactId).commentsParticipantSet({ threadId, key, removed }),
  );
  if (!removed) return;
  const w = withdrawHeldFor(env, artifactId, threadId, p);
  if (ctx) ctx.waitUntil(w);
  else await w;
}

/** #2240: how long one withdrawHeld call may take before it is retried. */
export const withdrawHeldTimeout = { ms: 10_000 };

function withdrawOnce(
  hub: NonNullable<ReturnType<typeof busHub>>,
  req: Parameters<NonNullable<ReturnType<typeof busHub>>["withdrawHeld"]>[0],
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(
      () => rej(new Error("withdrawHeld timed out")),
      withdrawHeldTimeout.ms,
    );
  });
  return Promise.race([hub.withdrawHeld(req), timeout]).finally(() =>
    clearTimeout(timer),
  );
}

/** #2240: the participant wrote this comment (same member, same bus identity or name). */
function isAuthoredBy(a: StoredActor, p: ParticipantRow): boolean {
  if (a.kind !== "user" || a.ref !== p.owner || !a.agent) return false;
  const id = a.agent.identity;
  if (id && p.identity) return id.identityId === p.identity.identityId;
  // The hub lowercases names, so compare as it does.
  return (id?.name ?? a.agent.name).toLowerCase() === p.name.toLowerCase();
}

/**
 * #2175: removing an agent withdraws the notices from the thread still held
 * for it on its owner's hub. Never throws: a failure leaves them to expire.
 */
async function withdrawHeldFor(
  env: Env,
  artifactId: string,
  threadId: string,
  p: ParticipantRow,
): Promise<void> {
  try {
    const hub = busHub(env, p.owner);
    if (!hub) return;
    const held = await call(() =>
      stub(env, artifactId).commentsHeldTargets({ threadId, key: p.key }),
    );
    // #2240: asks the removed agent authored, so the hub also drops their held ask_answered notices.
    // A failed read costs only the ask ids: the held targets still go.
    const own = await call(() =>
      stub(env, artifactId).commentsAskAuthors({ threadId }),
    )
      .then((asks) =>
        asks.filter((a) => isAuthoredBy(a.author, p)).map((a) => a.commentId),
      )
      .catch((e) => {
        logError("comment_withdraw_asks_read_failed", e);
        return [] as string[];
      });
    // Called even with no tracked targets: the hub also drops the thread's
    // held thread_reply rows by threadId (older ones carry no target).
    const req = {
      namespace: p.namespace,
      name: p.name,
      ...(p.identity ? { identityId: p.identity.identityId } : {}),
      artifactId,
      threadId,
      commentIds: [...new Set([...held.map((h) => h.commentId), ...own])],
    };
    // #2240: once more on an error or a timeout; the hub's idempotency (#2211)
    // makes the repeat return what the first call already withdrew.
    const { withdrawn } = await withdrawOnce(hub, req).catch(() =>
      withdrawOnce(hub, req),
    );
    const targets = withdrawn
      .filter(
        (w) =>
          w.key === p.key &&
          (w.kind === "mention" || w.kind === "asker" || w.kind === "reply"),
      )
      .map((w) => ({
        commentId: w.commentId,
        kind: w.kind as "mention" | "asker" | "reply",
      }));
    if (targets.length === 0) return;
    await call(() =>
      stub(env, artifactId).commentsTargetsWithdraw({
        threadId,
        key: p.key,
        targets,
      }),
    );
  } catch (e) {
    logError("comment_withdraw_held_failed", e);
  }
}

/** Edits a comment's body: its author only (403 forbidden). */
export async function editComment(
  env: Env,
  artifactId: string,
  threadId: string,
  commentId: string,
  who: CommentWho,
  viewer: CommentViewer,
  body: unknown,
): Promise<Comment> {
  const text = checkBody(body);
  const a = actorOf(who);
  const c = await call(() =>
    stub(env, artifactId).commentsEdit({
      threadId,
      commentId,
      by: { kind: a.kind, ref: a.ref },
      body: text,
      typed: a.kind === "user" && a.typed === true,
      rate: rateKeyOf(who),
    }),
  );
  return commentView(env, c, viewer);
}

/**
 * Deletes a comment. `who` is the caller as an author (null: a guest with no
 * id); `moderator`: the caller's level may delete anyone's (editor and up).
 * The root takes the whole thread with it, permanently.
 */
export async function deleteComment(
  env: Env,
  artifactId: string,
  threadId: string,
  commentId: string,
  who: CommentWho | null,
  moderator: boolean,
): Promise<void> {
  const a = who ? actorOf(who) : null;
  // `r` is undefined from an older DO mid-deploy: the delete stands, the index heals on read.
  const r = await call(() =>
    stub(env, artifactId).commentsDelete({
      threadId,
      commentId,
      by: a ? { kind: a.kind, ref: a.ref } : null,
      moderator,
      ...(who ? { rate: rateKeyOf(who) } : {}),
    }),
  );
  await indexDeleted(env, artifactId, threadId, commentId, r?.root === true);
}
