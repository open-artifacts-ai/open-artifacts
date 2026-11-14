import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { logWarn } from "../log.js";
import type {
  StoredComment,
  StoredParty,
  StoredThread,
} from "../runtime/comments-store.js";

/**
 * The asks index (#1623): artifact_asks, in D1, so the library can count and
 * filter the open asks addressed to a person without opening every artifact's
 * Durable Object. The DO is the source of truth. Every write here follows the
 * DO write, never fails the caller's action (a failure is logged as
 * asks_index_failed with the artifact id), and is repaired by reconcileAsks,
 * which a full comments list read runs. A row missing for a new ask is
 * invisible until then; a row left open for a closed ask is counted until then.
 */

/** Who may answer an ask for a party: a person, or the member whose agent was asked. */
export const addresseeOf = (p: StoredParty): string =>
  p.kind === "user" ? p.key : p.owner;

/** The distinct people an ask reaches. */
export const addressees = (to: StoredParty[]): string[] => [
  ...new Set(to.map(addresseeOf)),
];

async function guarded(
  op: string,
  artifactId: string,
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    await run();
  } catch (e) {
    logWarn("asks_index_failed", e, { op, artifactId });
  }
}

/** #2512: what the inbox shows of an ask, kept on its rows. */
export type AskInfo = {
  question: string;
  asker: string;
  askedAt: string;
  confirm: number;
};

/** The inbox fields of the ask on `c` (the caller checked it has one). */
export const askInfo = (c: StoredComment): AskInfo => ({
  question: c.ask?.question ?? "",
  asker: JSON.stringify(c.author),
  askedAt: c.createdAt,
  confirm:
    c.ask?.confirm === "passkey" || c.ask?.options.some((o) => o.action)
      ? 1
      : 0,
});

const INSERT =
  "insert or replace into artifact_asks (artifact_id, thread_id, comment_id, addressee, open, answered, question, asker, asked_at, confirm) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

/** A new ask: one open row per addressee. */
export const indexAsk = (
  env: Env,
  artifactId: string,
  threadId: string,
  commentId: string,
  to: StoredParty[],
  /** #2381: the decider (default: the asker's own user) waits on the ask too, asked or not. */
  decider: string | undefined,
  info: AskInfo,
) =>
  guarded("create", artifactId, () =>
    env.DB.batch(
      [...new Set([...addressees(to), ...(decider ? [decider] : [])])].map(
        (who) =>
          stmt(env.DB, INSERT).bind(
            artifactId,
            threadId,
            commentId,
            who,
            1,
            0,
            info.question,
            info.asker,
            info.askedAt,
            info.confirm,
          ),
      ),
    ),
  );

/** An answer closes the ask for everyone it was put to. */
export const indexAnswered = (
  env: Env,
  artifactId: string,
  commentId: string,
) =>
  guarded("answer", artifactId, () =>
    stmt(
      env.DB,
      "update artifact_asks set answered = 1, open = 0 where artifact_id = ? and comment_id = ?",
    )
      .bind(artifactId, commentId)
      .run(),
  );

/** #2381: a weigh-in closes the ask for the person who weighed in, not for the others. */
export const indexWeighed = (
  env: Env,
  artifactId: string,
  commentId: string,
  userId: string,
) =>
  guarded("weigh", artifactId, () =>
    stmt(
      env.DB,
      "update artifact_asks set answered = 1, open = 0 where artifact_id = ? and comment_id = ? and addressee = ?",
    )
      .bind(artifactId, commentId, userId)
      .run(),
  );

/** Resolving closes every ask of the thread; reopening reopens those not answered. */
export const indexStatus = (
  env: Env,
  artifactId: string,
  threadId: string,
  status: "open" | "resolved",
) =>
  guarded("status", artifactId, () =>
    stmt(
      env.DB,
      status === "resolved"
        ? "update artifact_asks set open = 0 where artifact_id = ? and thread_id = ?"
        : "update artifact_asks set open = 1 - answered where artifact_id = ? and thread_id = ?",
    )
      .bind(artifactId, threadId)
      .run(),
  );

/** A deleted reply drops its ask; a deleted root drops the thread's. */
export const indexDeleted = (
  env: Env,
  artifactId: string,
  threadId: string,
  commentId: string,
  root: boolean,
) =>
  guarded("delete", artifactId, () =>
    (root
      ? stmt(
          env.DB,
          "delete from artifact_asks where artifact_id = ? and thread_id = ?",
        ).bind(artifactId, threadId)
      : stmt(
          env.DB,
          "delete from artifact_asks where artifact_id = ? and comment_id = ?",
        ).bind(artifactId, commentId)
    ).run(),
  );

type Row = {
  thread_id: string;
  comment_id: string;
  addressee: string;
  open: number;
  answered: number;
  question: string | null;
  asker: string | null;
  asked_at: string | null;
  confirm: number | null;
};

/** The artifact's index rows, or null when D1 fails (then nothing is reconciled). */
export async function askRows(
  env: Env,
  artifactId: string,
): Promise<Row[] | null> {
  try {
    const { results } = await stmt(
      env.DB,
      "select thread_id, comment_id, addressee, open, answered, question, asker, asked_at, confirm from artifact_asks where artifact_id = ?",
    )
      .bind(artifactId)
      .all<Row>();
    return results;
  } catch (e) {
    logWarn("asks_index_failed", e, { op: "read", artifactId });
    return null;
  }
}

/**
 * Makes the artifact's rows (`results`, read before the threads) match its
 * threads (all of them: a partial read must not be passed). Writes only the
 * differences. It is also the backfill: an ask that predates the table, or
 * whose write failed, appears the first time someone lists the artifact's
 * comments. Rows for asks the DO no longer has are removed, unless the read
 * was truncated (it may lack them).
 */
export const reconcileAsks = (
  env: Env,
  artifactId: string,
  threads: StoredThread[],
  truncated: boolean,
  results: Row[],
) =>
  guarded("reconcile", artifactId, async () => {
    const want = new Map<string, Row>();
    for (const t of threads)
      for (const c of t.comments) {
        if (!c.ask) continue;
        const decider = c.ask.decider ?? c.author.ref;
        for (const who of new Set([...addressees(c.ask.to), decider])) {
          // The decision closes it for all; a weigh-in only for the one who made it (#2381).
          const answered =
            c.ask.answer || c.ask.history?.some((p) => p.by.ref === who)
              ? 1
              : 0;
          const open = t.status === "open" && !answered ? 1 : 0;
          const info = askInfo(c);
          want.set(`${c.id}|${who}`, {
            thread_id: t.id,
            comment_id: c.id,
            addressee: who,
            open,
            answered,
            question: info.question,
            asker: info.asker,
            asked_at: info.askedAt,
            confirm: info.confirm,
          });
        }
      }
    const have = new Map(
      results.map((r) => [`${r.comment_id}|${r.addressee}`, r]),
    );
    const ops: D1PreparedStatement[] = [];
    for (const [k, w] of want) {
      const h = have.get(k);
      if (
        !h ||
        h.open !== w.open ||
        h.answered !== w.answered ||
        h.question !== w.question ||
        h.asker !== w.asker ||
        h.asked_at !== w.asked_at ||
        h.confirm !== w.confirm
      )
        ops.push(
          stmt(env.DB, INSERT).bind(
            artifactId,
            w.thread_id,
            w.comment_id,
            w.addressee,
            w.open,
            w.answered,
            w.question,
            w.asker,
            w.asked_at,
            w.confirm,
          ),
        );
    }
    if (!truncated)
      for (const [k, h] of have)
        if (!want.has(k))
          ops.push(
            stmt(
              env.DB,
              "delete from artifact_asks where artifact_id = ? and comment_id = ? and addressee = ?",
            ).bind(artifactId, h.comment_id, h.addressee),
          );
    if (ops.length > 0) await env.DB.batch(ops);
  });
