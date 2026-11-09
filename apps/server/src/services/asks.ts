import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { logWarn } from "../log.js";
import type { StoredParty, StoredThread } from "../runtime/comments-store.js";

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

const INSERT =
  "insert or replace into artifact_asks (artifact_id, thread_id, comment_id, addressee, open, answered) values (?, ?, ?, ?, ?, ?)";

/** A new ask: one open row per addressee. */
export const indexAsk = (
  env: Env,
  artifactId: string,
  threadId: string,
  commentId: string,
  to: StoredParty[],
) =>
  guarded("create", artifactId, () =>
    env.DB.batch(
      addressees(to).map((who) =>
        stmt(env.DB, INSERT).bind(artifactId, threadId, commentId, who, 1, 0),
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
};

/**
 * Makes the artifact's rows match its threads (all of them: a partial read
 * must not be passed). One select; writes only the differences. It is also the
 * backfill: an ask that predates the table, or whose write failed, appears the
 * first time someone lists the artifact's comments. Rows for asks the DO no
 * longer has are removed, unless the read was truncated (it may lack them).
 */
export const reconcileAsks = (
  env: Env,
  artifactId: string,
  threads: StoredThread[],
  truncated: boolean,
) =>
  guarded("reconcile", artifactId, async () => {
    const want = new Map<string, Row>();
    for (const t of threads)
      for (const c of t.comments) {
        if (!c.ask) continue;
        const answered = c.ask.answer ? 1 : 0;
        const open = t.status === "open" && !answered ? 1 : 0;
        for (const who of addressees(c.ask.to))
          want.set(`${c.id}|${who}`, {
            thread_id: t.id,
            comment_id: c.id,
            addressee: who,
            open,
            answered,
          });
      }
    const { results } = await stmt(
      env.DB,
      "select thread_id, comment_id, addressee, open, answered from artifact_asks where artifact_id = ?",
    )
      .bind(artifactId)
      .all<Row>();
    const have = new Map(
      results.map((r) => [`${r.comment_id}|${r.addressee}`, r]),
    );
    const ops: D1PreparedStatement[] = [];
    for (const [k, w] of want) {
      const h = have.get(k);
      if (!h || h.open !== w.open || h.answered !== w.answered)
        ops.push(
          stmt(env.DB, INSERT).bind(
            artifactId,
            w.thread_id,
            w.comment_id,
            w.addressee,
            w.open,
            w.answered,
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
