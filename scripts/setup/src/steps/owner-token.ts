import { createHash, randomInt } from "node:crypto";
import { homeOf, patTokenFile } from "../secret-file.ts";
import { type State, writeState } from "../state.ts";
import { type Ctx, NeedInput, type Step } from "../step.ts";
import { names } from "./resources.ts";
import { jsonArray } from "./secrets.ts";

// Same format as @oa/shared newId/newPat (base58); test/deploy.test.ts checks isId/isPat.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const base58 = (n: number) =>
  Array.from({ length: n }, () => B58[randomInt(58)]).join("");
export const newPat = () => `oa_pat_${base58(32)}`;
/** Same as the server's sha256Hex (apps/server/src/util/crypto.ts). */
export const tokenHash = (s: string) =>
  createHash("sha256").update(s).digest("hex");
/** SQLite string literal. */
const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** Same cap as the server (apps/server/src/routes/tokens.ts MAX_ACTIVE). */
const MAX_ACTIVE = 50;

/**
 * Command 1 (D1 `execute` has no transaction, so a failure keeps earlier
 * effects; the order makes every partial state re-mintable):
 *  0 upsert the owner, 1 capped insert (changes 0 = cap hit), 2 verify the
 *  new row.
 * The old tokens are revoked only by command 2 (revokePriorSql), after the new
 * token is safely in its file: a capped or failed insert or a failed file
 * write never leaves the owner without a working token. Cost: a leftover
 * setup token counts toward the cap.
 * Carries the hash only, never the token.
 */
export function ownerStatements(
  email: string,
  tokenId: string,
  hash: string,
  now: number,
  label = "setup",
  cleanStale = false,
  mode: "install" | "upgrade" = "install",
) {
  const name = email.split("@")[0] || email;
  const e = lit(email);
  const stale = cleanStale
    ? [
        // --ci: leaked setup-ci tokens (SIGKILL/OOM) must not count toward the cap, so they go BEFORE the insert.
        // Safe because CI runs are serialized (workflow `concurrency: prod`): no concurrent run's live token is hit.
        revokeCiSql(email, now),
      ]
    : [];
  // --upgrade never writes users: a mistyped --owner-email must not move
  // ownership, and the token INSERT selects FROM users, so a row deleted after
  // the caller's pre-check cannot be recreated as an owner.
  const upsert =
    mode === "upgrade"
      ? undefined
      : `INSERT INTO users (id, email, name, role, created_at) VALUES (${lit(base58(16))}, ${e}, ${lit(name)}, 'owner', ${now}) ON CONFLICT(email) DO UPDATE SET role = 'owner' WHERE users.status = 'active'`;
  // A suspended or removed row keeps its role and gets no token (the server
  // signs in active users only); the status read lets apply() refuse.
  const active = upsert ? " AND status = 'active'" : "";
  const rest = [
    `INSERT INTO tokens (id, user_id, label, token_hash, created_at) SELECT ${lit(tokenId)}, id, ${lit(label)}, ${lit(hash)}, ${now} FROM users WHERE email = ${e}${active} AND (SELECT count(*) FROM tokens WHERE user_id = users.id AND revoked_at IS NULL) < ${MAX_ACTIVE}`,
    `SELECT id FROM tokens WHERE id = ${lit(tokenId)} AND revoked_at IS NULL`,
  ];
  return [
    ...(upsert ? [upsert, `SELECT status FROM users WHERE email = ${e}`] : []),
    ...stale,
    ...rest,
  ] as string[];
}

/**
 * --upgrade's read-only pre-check, before any write: who else owns the
 * install, and does the configured owner's row exist. Returns statement
 * results in that order.
 */
export const ownerUpgradeCheckSql = (email: string) => {
  const e = lit(email);
  return [
    `SELECT email FROM users WHERE role = 'owner' AND email <> ${e}`,
    `SELECT id FROM users WHERE email = ${e}`,
  ].join("; ");
};

/** Revokes the owner's other live tokens with this label, once the new row exists. */
export const revokePriorSql = (
  email: string,
  tokenId: string,
  now: number,
  label = "setup",
) =>
  `UPDATE tokens SET revoked_at = ${now} WHERE user_id = (SELECT id FROM users WHERE email = ${lit(email)}) AND label = ${lit(label)} AND revoked_at IS NULL AND id <> ${lit(tokenId)} AND EXISTS (SELECT 1 FROM tokens WHERE id = ${lit(tokenId)})`;

/** Revokes every live 'setup-ci' token of the owner. */
export const revokeCiSql = (email: string, now: number) =>
  `UPDATE tokens SET revoked_at = ${now} WHERE user_id = (SELECT id FROM users WHERE email = ${lit(email)}) AND label = 'setup-ci' AND revoked_at IS NULL`;

/** --revoke-ci-tokens: returns how many rows were revoked. */
export async function revokeCiTokens(ctx: Ctx): Promise<number> {
  const res = await d1Raw(
    ctx,
    `${revokeCiSql(ctx.opts.ownerEmail, Date.now())};`,
  );
  return res[0]?.meta?.changes ?? 0;
}
export const ownerSql = (...a: Parameters<typeof ownerStatements>) =>
  `${ownerStatements(...a).join("; ")};`;

/** Command 2, only after the insert succeeded: select, demote, verify. */
export function demoteStatements(email: string) {
  const e = lit(email);
  // Only once the target is an active owner, so no one is left without one.
  const ready = `EXISTS (SELECT 1 FROM users WHERE email = ${e} AND role = 'owner' AND status = 'active')`;
  return [
    `SELECT email FROM users WHERE role = 'owner' AND email <> ${e} AND ${ready}`,
    `UPDATE users SET role = 'admin' WHERE role = 'owner' AND email <> ${e} AND ${ready}`,
    `SELECT email FROM users WHERE role = 'owner' AND email = ${e}`,
  ];
}

type D1Result = { results?: unknown[]; meta?: { changes?: number } };
/** Runs SQL on the remote D1; returns one result per statement. */
async function d1Raw(ctx: Ctx, sql: string): Promise<D1Result[]> {
  const db = names(ctx.opts.name).d1;
  const args = ["d1", "execute", db, "--remote", "--json", "--command", sql];
  return jsonArray<D1Result>(await ctx.wrangler(args), "wrangler d1 execute");
}
const d1 = async (ctx: Ctx, sql: string): Promise<unknown[]> =>
  (await d1Raw(ctx, sql)).flatMap((r) => r.results ?? []);

/** --ci: revokes the run's own token row (hash-only; idempotent). */
export async function revokeToken(ctx: Ctx, id: string) {
  await d1Raw(
    ctx,
    `UPDATE tokens SET revoked_at = ${Date.now()} WHERE id = ${lit(id)} AND revoked_at IS NULL;`,
  );
}

const live = (ctx: Ctx, id: string) =>
  d1(
    ctx,
    `SELECT id FROM tokens WHERE id = ${lit(id)} AND revoked_at IS NULL;`,
  ).then((rows) => rows.length > 0);

/** Where this run's PAT file lives (an absolute path). */
const tokenFileOf = (ctx: Ctx) =>
  patTokenFile(homeOf(ctx.deps.env), ctx.opts.appHost);

const DASHBOARD = "Settings → Agents";

/** A revoke that failed after the new file was saved is retried here, on the next run. */
async function retryPendingRevoke(state: State, ctx: Ctx) {
  const id = state.pendingRevokeTokenId;
  if (!id || ctx.opts.ci) return;
  if (ctx.opts.check) {
    ctx.notes.push("revoking the previous token is still pending");
    return;
  }
  try {
    await d1Raw(ctx, `${revokePriorSql(ctx.opts.ownerEmail, id, Date.now())};`);
  } catch {
    throw new NeedInput(
      `the previous owner token couldn't be revoked; rerun setup, or revoke it in the dashboard (${DASHBOARD})`,
    );
  }
  state.pendingRevokeTokenId = undefined;
  ctx.notes.push("revoked the previous owner token (retried)");
}

export const ownerToken: Step = {
  name: "owner-token",
  async check(state, ctx) {
    await retryPendingRevoke(state, ctx);
    if (ctx.opts.newOwnerToken) return "todo";
    // --ci --upgrade still mints the in-memory setup-ci token so selftest runs the full MCP check (revoked at the end).
    if (ctx.opts.upgrade && ctx.opts.ci) return "todo";
    if (ctx.opts.upgrade) {
      ctx.notes.push("kept (--upgrade); pass --new-owner-token to mint one");
      const file = tokenFileOf(ctx);
      if (
        !ctx.opts.ci &&
        state.ownerTokenId &&
        ctx.fs.read(file) === null &&
        (await live(ctx, state.ownerTokenId))
      )
        ctx.notes.push(
          `no token file at ${file}; pass --new-owner-token if a client needs one`,
        );
      return "done";
    }
    if (ctx.opts.ci) return "todo";
    if (!state.ownerTokenId || !(await live(ctx, state.ownerTokenId)))
      return "todo";
    if (ctx.fs.read(tokenFileOf(ctx)) === null) {
      ctx.notes.push("the token file is missing; rerun with --new-owner-token");
      return "todo";
    }
    ctx.notes.push(
      `token ${state.ownerTokenId} exists; pass --new-owner-token to mint another`,
    );
    return "done";
  },
  async apply(state, ctx) {
    const token = newPat();
    const id = base58(16);
    const ci = ctx.opts.ci;
    const prev = state.ownerTokenId;
    // Recorded first, so a crash after the insert still leaves the row tracked.
    // Under --ci the id is tracked in ctx only (state is never written) and revoked at the end.
    if (ci) ctx.ciTokenId = id;
    else {
      state.ownerTokenId = id;
      writeState(ctx.fs, ctx.root, state);
    }
    const untrack = () => {
      if (ci) return;
      state.ownerTokenId = prev;
      writeState(ctx.fs, ctx.root, state);
    };
    // Nothing was minted yet: no revoke to run or to report.
    const notMinted = () => {
      if (ci) ctx.ciTokenId = undefined;
    };
    const uncertain = () => {
      untrack();
      return {
        status: "action_required" as const,
        message: "owner token state uncertain; rerun with --new-owner-token",
      };
    };
    const email = ctx.opts.ownerEmail;
    const label = ci ? "setup-ci" : "setup";
    // --upgrade: read-only ownership check, before any write. Never demote and
    // never set role='owner' here, so a mistyped owner email can't move
    // ownership during a routine release.
    if (ctx.opts.upgrade) {
      let pre: D1Result[];
      try {
        pre = await d1Raw(ctx, `${ownerUpgradeCheckSql(email)};`);
      } catch {
        untrack();
        notMinted();
        return uncertain();
      }
      if ((pre[0]?.results ?? []).length) {
        untrack();
        notMinted();
        throw new Error(
          "setup --upgrade won't change ownership: this install already has a different owner. Check the owner email, or transfer ownership on purpose with a non-upgrade run using --new-owner-token",
        );
      }
      if (!(pre[1]?.results ?? []).length) {
        untrack();
        notMinted();
        throw new Error(
          "setup --upgrade won't change ownership: the configured owner has no user row in this install. Check the owner email, or run setup without --upgrade to create the owner",
        );
      }
    }
    const stmts = ownerStatements(
      email,
      id,
      tokenHash(token),
      Date.now(),
      label,
      ci,
      ctx.opts.upgrade ? "upgrade" : "install",
    );
    let res: D1Result[];
    try {
      res = await d1Raw(ctx, `${stmts.join("; ")};`);
    } catch {
      return uncertain();
    }
    if (res.length < stmts.length) return uncertain();
    const status = (res[1]?.results?.[0] as { status?: string } | undefined)
      ?.status;
    if (!ctx.opts.upgrade && status !== "active") {
      untrack();
      notMinted();
      throw new Error(
        `setup won't make a ${status ?? "missing"} user the owner: nothing was changed. Reactivate that user, or pass a different --owner-email`,
      );
    }
    const [insert, verify] = [res[res.length - 2], res[res.length - 1]];
    if (!insert?.meta?.changes) {
      untrack();
      return {
        status: "action_required",
        message: `owner has ${MAX_ACTIVE} active tokens; revoke some in Settings, then rerun setup (an old setup token still counts toward the cap; revoke it in Settings)`,
      };
    }
    if (!verify?.results?.length)
      throw new Error(
        `token row ${id} missing after the insert; is the owner in users? rerun setup`,
      );
    ctx.pat = token;
    // The new token goes to its file BEFORE the old one is revoked, so a failed
    // write leaves the old token (and its file) valid. Not under --ci: that
    // token is revoked at the end of the run, so a file would only go stale.
    let tokenFile: string | undefined;
    if (!ci) {
      tokenFile = tokenFileOf(ctx);
      try {
        if (!ctx.fs.writeSecret)
          throw new Error("this fs cannot write secret files");
        ctx.fs.writeSecret(tokenFile, `${token}\n`);
      } catch (e) {
        ctx.pat = undefined;
        // Retire the unusable new row; the old token stays valid.
        let orphan = "";
        try {
          await revokeToken(ctx, id);
        } catch {
          orphan = `; the new token row ${id} couldn't be retired either: revoke it in the dashboard (${DASHBOARD})`;
        }
        untrack();
        throw new Error(
          `could not save the new owner token to ${tokenFile} (${(e as Error).message}); the previous token is unchanged; fix that and rerun with --new-owner-token${orphan}`,
        );
      }
    }
    ctx.notes.push(
      ci
        ? "owner token minted for selftest (not printed; revoked at end of run)"
        : `minted owner token ${id}; saved to ${tokenFile} (don't read or print it; point your client config at it)`,
    );
    const stale = ci ? (res[res.length - 3]?.meta?.changes ?? 0) : 0;
    if (stale > 0) ctx.notes.push(`revoked ${stale} stale setup-ci tokens`);
    // Two commands, so one failing doesn't skip the other. The file and state are kept either way.
    let failed: string | undefined;
    try {
      const out = await d1Raw(
        ctx,
        `${revokePriorSql(email, id, Date.now(), label)};`,
      );
      const revoked = out[0]?.meta?.changes ?? 0;
      if (revoked > 0)
        ctx.notes.push(`revoked ${revoked} prior ${label} tokens`);
      state.pendingRevokeTokenId = undefined;
    } catch {
      failed = `the new token is saved to ${tokenFile ?? "memory"}, but the old token couldn't be revoked; rerun setup, or revoke it in the dashboard (${DASHBOARD})`;
      if (!ci) state.pendingRevokeTokenId = id;
    }
    // --upgrade never demotes (see the pre-check above).
    if (!ctx.opts.upgrade) {
      try {
        const dem = await d1Raw(ctx, `${demoteStatements(email).join("; ")};`);
        const demoted = dem[0]?.results ?? [];
        // A count, not the emails: CI logs may be public.
        if (demoted.length)
          ctx.notes.push(
            `demoted ${demoted.length} previous owner${demoted.length === 1 ? "" : "s"} to admin`,
          );
      } catch {
        failed ??= `the new token is saved to ${tokenFile ?? "memory"}, but the previous owner couldn't be demoted; rerun with --new-owner-token`;
      }
    }
    if (failed && !ci)
      return {
        status: "action_required",
        message: failed,
        data: { tokenId: id, tokenFile },
      };
    if (failed) ctx.notes.push(failed);
    if (ci) {
      ctx.data = { tokenId: id };
      return undefined;
    }
    ctx.data = {
      tokenId: id,
      tokenFile,
      ...(ctx.opts.printToken ? { token } : {}),
    };
    if (ctx.opts.printToken) ctx.human = `  token: ${token}`;
    return undefined;
  },
};
