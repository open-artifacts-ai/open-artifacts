// How a publisher and their agent appear to a viewer. A token (PAT) label is
// the owner's private note ("Only you see it"): everyone but the token's
// owner (the version's createdBy) sees "<owner name>'s agent". A grant's
// client name (for example "Claude Code") is a product and shows as is; a
// grant's owner-set label lives only in agent_grants and never reaches a
// version payload.
import {
  type AgentRef,
  ANIMALS,
  type CommentAuthor,
  NAME_FILLERS,
  PRESENCE_PALETTE_SIZE,
  stripNameControls,
} from "@oa/shared";

/** Longest name shown, in code points. */
const NAME_MAX = 80;

/** Strip controls, collapse whitespace, trim. */
const tidyName = (s: string): string =>
  stripNameControls(s).replace(/\s+/g, " ").trim();

/** tidyName, cut to NAME_MAX code points; empty is null. */
export const cleanName = (s: string | null): string | null => {
  if (s === null) return null;
  const cut = [...tidyName(s)].slice(0, NAME_MAX).join("").trim();
  return cut === "" ? null : cut;
};

/**
 * A member's name for other viewers: cleaned, or null when it is an email
 * or reads as an agent.
 * Member.name falls back to the email when the user has no real name
 * (effectiveName), and an email never goes out as a name. Checked before the
 * cut, or an email past NAME_MAX would no longer equal itself.
 */
export const publicName = (u: { name: string | null }): string | null => {
  if (u.name === null) return null;
  const whole = tidyName(u.name);
  // NFKC folds the full-width (U+FF20) and small (U+FE6B) at signs to "@";
  // only the check is normalized, the shown name is not.
  if (whole.normalize("NFKC").includes("@")) return null;
  // #1822: a name that reads as an agent ("Leo's agent", set or from SSO) is not a person's.
  return readsAsAgent(whole) ? null : cleanName(whole);
};

/** publicName, or "Member" when there is none. */
export const shownName = (u: { name: string | null; email: string }): string =>
  publicName(u) ?? "Member";

/**
 * Whether a version's agent name may be the publisher's private token label,
 * from `versions.agent_via`. Only a grant (`g:`, the client's own name) is
 * public. A token (`t:`) and a NULL via (rows before migration 0012, when a
 * name could be either) are private.
 */
export const isPrivateAgent = (via: string | null): boolean =>
  !via?.startsWith("g:");

/** The stand-in when the publisher has no public name. */
export const MEMBERS_AGENT = "A member's agent";

/**
 * `versions.agent_via` of a row whose private label was overwritten with
 * MEMBERS_AGENT because its publisher's user row was deleted, before removal
 * became soft (#829). created_by there names the instance owner, not the
 * publisher, so nothing may be derived from it. Nothing writes this marker any
 * more, but those rows keep it forever, so this read path stays.
 */
export const SCRUBBED_VIA = "r:";

/** The stand-in for a private label: "<publisher>'s agent", or MEMBERS_AGENT. */
export const ownersAgent = (publisher: {
  name: string | null;
  email: string;
}): string => {
  const name = publicName(publisher);
  return name === null ? MEMBERS_AGENT : `${name}'s agent`;
};

/**
 * The agent as `viewerId` sees it (null: anonymous), from the version's
 * `agent_via`. The publisher (the version's createdBy, who owns the token)
 * sees the label; everyone else sees ownersAgent for a private name. A
 * scrubbed row reads the same for everyone, and createdBy isn't its publisher.
 */
export function agentFor(
  agent: AgentRef,
  via: string | null,
  publisher: { id: string; name: string | null; email: string },
  viewerId: string | null,
): AgentRef {
  if (via === SCRUBBED_VIA) return { ...agent, masked: true };
  // The owner of the grant sees its raw client name in their own views.
  if (viewerId === publisher.id) return agent;
  if (!isPrivateAgent(via))
    return {
      name: knownProduct(agent.name) ?? ownersAgent(publisher),
      version: agent.version,
      ...(knownProduct(agent.name) ? {} : { masked: true }),
    };
  return { name: ownersAgent(publisher), version: agent.version, masked: true };
}

// ---------------------------------------------------------------- faces (#1822)

/** FNV-1a, 32 bit: the one small non-crypto hash for color and animal. */
export const fnv1a = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

/** Hub kind to the product it runs. Fixed: a client never names its own product. */
const PRODUCTS: Record<string, string> = {
  "claude-code": "Claude Code",
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  pi: "Pi",
  omp: "omp",
  hermes: "Hermes",
  openclaw: "OpenClaw",
};

/**
 * The product a grant's self-asserted client name stands for: only an exact
 * match of a known product (case-insensitive, after cleanName), in canonical
 * casing; else null. A client never names itself anything else (#1894).
 */
export const knownProduct = (name: string): string | null => {
  const given = (cleanName(name) ?? "").toLowerCase();
  return Object.values(PRODUCTS).find((p) => p.toLowerCase() === given) ?? null;
};

/** The face of one bus identity, the same on every artifact. Never returns the id. */
export const faceOf = (identityId: string): { id: string; color: number } => ({
  id: ANIMALS[fnv1a(identityId) % ANIMALS.length]?.id ?? "fox",
  color: fnv1a(`color:${identityId}`) % PRESENCE_PALETTE_SIZE,
});

/** Lookalike letters (Cyrillic, Greek) to the Latin they imitate. */
const LOOKALIKE: Record<string, string> = {
  а: "a",
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  у: "y",
  х: "x",
  і: "i",
  ј: "j",
  ѕ: "s",
  ԁ: "d",
  һ: "h",
  ӏ: "l",
  ԛ: "q",
  ԝ: "w",
  к: "k",
  м: "m",
  н: "h",
  т: "t",
  в: "b",
  α: "a",
  β: "b",
  ε: "e",
  ι: "i",
  κ: "k",
  ν: "v",
  ο: "o",
  օ: "o",
  ɑ: "a",
  ʟ: "l",
  п: "n",
  ρ: "p",
  τ: "t",
  υ: "u",
  χ: "x",
  γ: "y",
  η: "n",
  μ: "u",
  ω: "w",
  "0": "o",
  "1": "l",
  "|": "l",
};

const FILLERS = new RegExp(NAME_FILLERS.source, "gu");

/** A name with controls and invisible fillers gone, marks off, case and lookalikes folded. */
const fold = (name: string): string =>
  [
    ...stripNameControls(name)
      .replace(FILLERS, "")
      .normalize("NFKC")
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(FILLERS, "")
      .toLowerCase()
      .toUpperCase()
      .toLowerCase(),
  ]
    .map((c) => LOOKALIKE[c] ?? c)
    .join("");

/**
 * A name's skeleton, best effort (not a full confusables table): folded,
 * capital I and small l one letter, letters and digits only.
 */
export const skeleton = (name: string): string =>
  fold(name)
    .replace(/i/g, "l")
    .replace(/[^\p{L}\p{N}]/gu, "");

// #1894: phrasings that read as an agent, matched on the folded name. The agent
// word counts only after a possessive or separator, or leading in "Agent of X",
// so Agent Smith, Agnes, Botha, Abbot, Ai Weiwei, Claude Monet and Aiden stay names.
const APOS = /['\u2018\u2019\u02bc\u2032\u00b4`]/gu;
// Digits fold to l/o lookalikes, so a trailing number may arrive as those.
const NUM = String.raw`(?:\s*#?[\dlo]{1,3})?`;
const WORD = String.raw`(?:agent|assistant|bot|ai|claude)`;
const AGENT_PATTERNS: RegExp[] = [
  // "Leo's agent", "Leo Urbina's AI", "Leo's Claude 2"
  new RegExp(String.raw`'\s*s\s+${WORD}${NUM}$`, "u"),
  // "Leos agent" (no apostrophe): only the unambiguous words
  new RegExp(String.raw`\S+s\s+(?:agent|assistant)${NUM}$`, "u"),
  // "Leo, agent", "Leo - agent" ("ai" excluded: "Wei, Ai" is a name)
  new RegExp(
    String.raw`(?:,|\s[-\u2013\u2014]+)\s*(?:agent|assistant|bot)${NUM}$`,
    "u",
  ),
  // "Leo (agent)", "Leo (AI)"
  new RegExp(String.raw`\(\s*(?:agent|assistant|bot|ai)\)?${NUM}$`, "u"),
  // "Agent of Leo", "Assistant to Leo"
  /^(?:agent|assistant|bot|ai)\s+(?:of|to|for)\s+\S/u,
];
export const readsAsAgent = (name: string): boolean => {
  const n = fold(name)
    .replace(APOS, "'")
    .replace(/[\p{P}\p{S}\s]+$/u, (t) => (t.startsWith(")") ? ")" : ""));
  return AGENT_PATTERNS.some((re) => re.test(n));
};

/** A name an agent may show: one that reads as a person's agent shows the product, or "Agent". */
export const plainAgentName = (name: string, product?: string): string =>
  readsAsAgent(name) ? (product ?? "Agent") : name;

/** A short stable tag for a member, from the id; never the email. */
export const memberTag = (id: string): string =>
  fnv1a(`tag:${id}`).toString(16).padStart(8, "0").slice(0, 6);

type Member = { id: string; name: string | null; email: string };

/**
 * Whose names are ambiguous: skeleton to the members who have it, removed ones too
 * (a removed person's name stays reserved). Built once per read, then asked per owner.
 */
export type NameClashes = Map<string, Set<string>>;

export const nameClashes = (members: Iterable<Member>): NameClashes => {
  const out: NameClashes = new Map();
  for (const m of members) {
    const n = publicName(m);
    if (n === null) continue;
    const k = skeleton(n);
    const set = out.get(k) ?? new Set<string>();
    set.add(m.id);
    out.set(k, set);
  }
  return out;
};

/** Another member has this member's name (or a lookalike of it). */
export const clashes = (c: NameClashes, u: Member): boolean => {
  const n = publicName(u);
  if (n === null) return false;
  const ids = c.get(skeleton(n));
  return !!ids && [...ids].some((id) => id !== u.id);
};

/** Who is reading, for what an agent shows. `guest`: signed out, or a guest-role member. */
export type FaceViewer = {
  userId: string | null;
  guest: boolean;
  /**
   * Signed out, a guest role, or a guest or restricted cap (never the plan
   * cap): gets no linked, product or animal, so the stable animal id cannot
   * join one agent's masked comments across artifacts (#1890).
   */
  outsider?: boolean;
};

/**
 * "for <this>" on an agent: the owner's name when it is theirs alone; on a
 * clash "<name> (member <tag>)" to a signed-in member and "Member" to a guest, so no
 * agent reads as another person's. No owner row reads "Member".
 */
export const forLine = (
  u: Member | undefined,
  v: FaceViewer,
  c: NameClashes,
): string => {
  if (!u) return "Member";
  if (!clashes(c, u)) return shownName(u);
  return v.guest ? "Member" : `${shownName(u)} (member ${memberTag(u.id)})`;
};

/** "<owner>'s agent"; MEMBERS_AGENT when the owner is unknown, nameless or clashes. */
export const agentOwnedBy = (u: Member | undefined, c: NameClashes): string =>
  !u || clashes(c, u) ? MEMBERS_AGENT : ownersAgent(u);

/**
 * The linked, product and animal of a bus identity: the one rule for a
 * comment author and a version's agent. An outsider (signed out, guest role,
 * guest or restricted cap) gets none, so the stable animal cannot join one
 * agent's masked work across artifacts (#1890, #2004).
 */
export const linkedFields = (
  identity: { identityId: string; kind: string },
  outsider: boolean | undefined,
): {
  linked?: true;
  product?: string;
  animal?: { id: string; color: number };
} => {
  if (outsider) return {};
  const product = PRODUCTS[identity.kind];
  return {
    linked: true,
    ...(product ? { product } : {}),
    animal: faceOf(identity.identityId),
  };
};

/**
 * An agent-written comment's author as `v` sees it, from the stored actor.
 * Linked (the connection proved a bus session): the bus name, the product from
 * the hub kind, an animal from the identity. A guest sees "<owner>'s agent"
 * instead of the bus name. Unlinked: the connection's label under #1800's
 * rules (a private token label only to its owner), linked false, no animal.
 */
export function agentFace(
  actor: { ref: string; agent: NonNullable<StoredActorAgent> },
  v: FaceViewer,
  owner: Member | undefined,
  c: NameClashes,
): CommentAuthor {
  const a = actor.agent;
  const me = v.userId !== null && v.userId === actor.ref;
  const base = {
    kind: "agent" as const,
    id: actor.ref,
    for: forLine(owner, v, c),
    me,
  };
  if (a.identity) {
    const product = PRODUCTS[a.identity.kind];
    const bus = plainAgentName(cleanName(a.identity.name) ?? "Agent", product);
    return {
      ...base,
      name: v.guest && !me ? agentOwnedBy(owner, c) : bus,
      ...linkedFields(a.identity, v.outsider),
    };
  }
  // An unlinked grant's client name is self-asserted: shown only when it is
  // exactly a known product, else "<person>'s agent" (a bus name never).
  // The owner sees the raw client name in their own views (#1894).
  const grantName = (): string => {
    return (
      knownProduct(a.name) ?? (owner ? agentOwnedBy(owner, c) : MEMBERS_AGENT)
    );
  };
  const name = me
    ? plainAgentName(a.name)
    : !isPrivateAgent(a.via)
      ? grantName()
      : owner
        ? agentOwnedBy(owner, c)
        : agentFor(
            { name: a.name, version: null },
            a.via,
            { id: actor.ref, name: null, email: "" },
            v.userId,
          ).name;
  return {
    ...base,
    name: name.trim() === "" ? "Agent" : name,
    ...(v.outsider ? {} : { linked: false }),
  };
}

/**
 * The face of a named bus agent whose identity was stored when it was
 * mentioned or asked (#1890): the same agentFace as an author, so
 * linked, product and animal agree. `owner` is its stored owner's id.
 */
export const partyIdentityFace = (
  p: {
    name: string;
    owner: string;
    identity: { identityId: string; kind: string };
  },
  v: FaceViewer,
  owner: Member | undefined,
  c: NameClashes,
): CommentAuthor =>
  agentFace(
    {
      ref: p.owner,
      agent: {
        name: p.name,
        via: null,
        identity: { ...p.identity, name: p.name },
      },
    },
    v,
    owner,
    c,
  );

type StoredActorAgent = {
  name: string;
  via: string | null;
  identity?: { identityId: string; name: string; kind: string };
};
