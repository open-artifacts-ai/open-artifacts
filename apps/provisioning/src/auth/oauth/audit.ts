import type { Env } from "../../env.js";

// The OAuth admin_audit rows (design v7 4.9, 9A.8) the token service does
// not write itself (it writes oauth.grant and token.revoke in its batch):
// oauth.denied (actor: the admin) and oauth.refresh_refused (actor: the
// token). Written here as the token service writes its rows, so they need
// no principal (the refresh callback has none).

export type OAuthAuditEntry = {
  action: "oauth.denied" | "oauth.refresh_refused";
  actor: { kind: "admin" | "token"; label: string };
  tokenId?: string;
  outcome: "ok" | "refused";
  code?: string;
  detail: Record<string, unknown>;
};

export async function oauthAudit(
  env: Pick<Env, "PLATFORM_DB">,
  e: OAuthAuditEntry,
  now: number = Date.now(),
): Promise<void> {
  await env.PLATFORM_DB.prepare(
    `INSERT INTO admin_audit (at, actor_kind, actor_label, token_id, action, outcome, code, detail)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(
      now,
      e.actor.kind,
      e.actor.label,
      e.tokenId ?? null,
      e.action,
      e.outcome,
      e.code ?? null,
      JSON.stringify(e.detail),
    )
    .run();
}
