import { createHash } from "node:crypto";
import { apiReq, call, deleteThrowaways } from "./fixtures.ts";
import {
  type Cred,
  describeRes,
  parseJson,
  readBody,
  sessionCred,
  withCred,
} from "./http.ts";
import { crossCheck, seedMarker } from "./refused.ts";
import type { Target } from "./targets.ts";
import { type OpenSocket, wsOpen } from "./ws.ts";

// LIFE-6 and WS-3 (#1137): data carried through rl-p's lifecycle. P13 seeds
// rl-p with a private marker artifact, a member and a share to that member;
// after each step that keeps the install (upgrade, rollback, resume,
// restore) the probe re-reads all three and repeats B's refusal, rl-b's PAT
// at rl-p (guard.test.ts's "the host's own marker artifact" crossCheck). P20
// holds an events socket across the suspend. Every check here is one try:
// a refusal or a close is never polled for. Messages name what changed, never
// an address, a host, an install id or a marker (the run log is public).

export interface Seed {
  /** rl-p, with its R26 PAT and hook key (adoptTarget). */
  p: Target;
  pat: Cred;
  /** rl-b, the other install: its R26 PAT and its own marker (the A side). */
  b: Target;
  bPat: Cred;
  bArtifact: string;
  /** rl-p's marker artifact, and what it read as right after the seed. */
  artifact: string;
  summary: string;
  contentSha: string;
  /** The member the seed made; the artifact is shared with it as viewer. */
  member: string;
}

/** A private markdown artifact's entry (apps/server manifest.ts defaultEntry). */
const ENTRY = "README.md";
const MEMBER_LOCAL = "redline-lifecycle-member";

const sha = (s: string) =>
  createHash("sha256").update(s).digest("hex").slice(0, 16);

const get = async (t: Target, cred: Cred, path: string, what: string) => {
  const { res, text } = await call(apiReq(t, cred, "GET", path), what);
  return { json: parseJson(res, text, what), text };
};

/** The summary fields a lifecycle step must keep, as one comparable string. */
function summaryOf(v: unknown): string {
  const a = (v ?? {}) as Record<string, unknown>;
  return JSON.stringify({
    id: a.id,
    title: a.title,
    format: a.format,
    visibility: a.visibility,
    currentVersion: a.currentVersion,
    deletedAt: a.deletedAt,
    owner: (a.owner as { id?: unknown } | undefined)?.id,
  });
}

/** What differs between two summaryOf strings, by field name only. */
function fieldsDiffering(x: string, y: string): string {
  const a = JSON.parse(x) as Record<string, unknown>;
  const b = JSON.parse(y) as Record<string, unknown>;
  return Object.keys(a)
    .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    .join(", ");
}

const artifactPath = (id: string) =>
  `/api/v1/artifacts/${encodeURIComponent(id)}`;

/**
 * Seeds rl-p: a private marker artifact, a member (the session hook, which
 * sends no email), a viewer share to that member; then rl-b's own marker for
 * crossCheck's A side. Returns once all exist; the caller runs `reread` as the
 * baseline. A setup hook or publish that got no answer is infra.
 */
export async function seedLife(
  p: Target,
  pat: Cred,
  b: Target,
  bPat: Cred,
): Promise<Seed> {
  const { id: artifact, marker } = await seedMarker(p, pat);
  const member = `${MEMBER_LOCAL}@${p.testDomain}`;
  await sessionCred(p, member, "member", { setup: true });
  await call(
    apiReq(p, pat, "PUT", `${artifactPath(artifact)}/shares`, {
      email: member,
      role: "viewer",
    }),
    "rl-p share",
  );
  const s = await get(p, pat, artifactPath(artifact), "rl-p artifact");
  const sj = s.json as { title?: unknown; visibility?: unknown };
  // The baseline must be what was sent: a later "unchanged" means nothing else.
  if (sj.title !== marker || sj.visibility !== "private")
    throw new Error("the seeded artifact is not the private marker sent");
  const c = await call(
    apiReq(
      p,
      pat,
      "GET",
      `${artifactPath(artifact)}/versions/1/files/${ENTRY}`,
    ),
    "rl-p artifact content",
  );
  const { id: bArtifact } = await seedMarker(b, bPat);
  return {
    p,
    pat,
    b,
    bPat,
    bArtifact,
    artifact,
    summary: summaryOf(s.json),
    contentSha: sha(c.text),
    member,
  };
}

/**
 * One re-read of the seed: the artifact's summary and content as seeded, the
 * share and the member still there, and rl-b's PAT still refused at rl-p.
 * Throws an Error whose message is safe for the public log.
 */
export async function reread(s: Seed): Promise<void> {
  const at = artifactPath(s.artifact);
  const sum = summaryOf((await get(s.p, s.pat, at, "the artifact")).json);
  if (sum !== s.summary)
    throw new Error(
      `the artifact's ${fieldsDiffering(s.summary, sum)} changed`,
    );
  const c = await call(
    apiReq(s.p, s.pat, "GET", `${at}/versions/1/files/${ENTRY}`),
    "the artifact's content",
  );
  if (sha(c.text) !== s.contentSha)
    throw new Error(
      `the artifact's content changed (sha256:${s.contentSha} -> sha256:${sha(c.text)})`,
    );
  const shares = (await get(s.p, s.pat, `${at}/shares`, "the shares")).json as {
    email?: unknown;
    role?: unknown;
  }[];
  if (!Array.isArray(shares)) throw new Error("the shares: not a list");
  const sh = shares.find((x) => x.email === s.member);
  if (!sh) throw new Error("the share to the seeded member is gone");
  if (sh.role !== "viewer")
    throw new Error(
      `the share's role is ${typeof sh.role === "string" ? sh.role.slice(0, 12) : "missing"}, want viewer`,
    );
  const members = (await get(s.p, s.pat, "/api/v1/members", "the members"))
    .json as { email?: unknown; role?: unknown }[];
  if (!Array.isArray(members)) throw new Error("the members: not a list");
  const m = members.find((x) => x.email === s.member);
  if (!m) throw new Error("the seeded member is gone");
  if (m.role !== "member")
    throw new Error(
      `the seeded member's role is ${typeof m.role === "string" ? m.role.slice(0, 12) : "missing"}, want member`,
    );
  // B's refusal, as guard.test.ts: each install's own PAT reads its own
  // marker, then rl-b's PAT at rl-p's must be refused (expectRefused).
  const art = (cred: Cred, t: Target) =>
    new Request(
      `${t.app}${artifactPath(t === s.b ? s.bArtifact : s.artifact)}`,
      withCred(cred),
    );
  try {
    await crossCheck(art, { a: s.b, b: s.p, credA: s.bPat, credB: s.pat });
  } catch (e) {
    if ((e as Error).message?.startsWith("infra: ")) throw e;
    throw new Error(`rl-b's PAT at rl-p: ${(e as Error).message}`);
  }
}

/**
 * An events socket on rl-p's marker artifact with rl-p's PAT (live.test.ts's
 * endpoint), held open. Anything but a 101 throws.
 */
export async function openSocket(s: Seed): Promise<OpenSocket> {
  const { res, socket } = await wsOpen(
    new Request(
      `${s.p.app}${artifactPath(s.artifact)}/events`,
      withCred(s.pat),
    ),
  );
  if (res.status !== 101 || !socket)
    throw new Error(
      `the events socket: ${describeRes(res, await readBody(res))}, want 101`,
    );
  return socket;
}

/** Deletes rl-b's marker (rl-p's data goes with rl-p's purge). */
export async function dropTwin(s: Seed): Promise<void> {
  if (await deleteThrowaways(s.b, s.bPat, [s.bArtifact]))
    throw new Error("rl-b's seed marker was not deleted");
}
