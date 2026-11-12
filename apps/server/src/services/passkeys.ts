import {
  ASK_ACTIONS,
  type AskAction,
  type AskOption,
  newId,
  PASSKEY_CHALLENGE_TTL_S,
  PASSKEY_COOLING_MS,
  type Passkey,
  type PasskeyChallenge,
  type PasskeySettings,
  type PasskeySettingsPut,
} from "@oa/shared";
import { counterBucket } from "../auth/codes.js";
import {
  assertionCredentialId,
  newChallenge,
  PasskeyError,
  verifyAssertion,
  verifyRegistration,
} from "../auth/webauthn.js";
import { stmt } from "../db/stmt.js";
import { sendEmail, takeAll } from "../email/send.js";
import { passkeyAddedEmail } from "../email/templates.js";
import type { Env } from "../env.js";
import { ApiError, appOrigin } from "../http/errors.js";
import { logWarn } from "../log.js";
import { audit, userActor } from "./audit.js";
import { getSettings } from "./members.js";

// Passkey-confirmed picks (#2263): the member's passkeys, the single-use
// WebAuthn challenges (table pick_assertions), and the "ask for a passkey to
// approve" switches. A passkey confirms only once it is 24 h old. Nothing
// here trusts the client: the challenge, the binding and the passkey are all
// read from D1, and a challenge is consumed with a compare-and-set before any
// effect is recorded.

export const MAX_PASSKEYS = 10;
/** Challenges a member may be issued per 10 minutes, all kinds together. */
export const CHALLENGE_BUDGET = 10;

export const rpIdOf = (env: Pick<Env, "APP_HOST">): string =>
  env.APP_HOST.split(":")[0] as string;

type PasskeyRow = {
  id: string;
  credential_id: string;
  public_key: string;
  alg: number;
  sign_count: number;
  label: string;
  created_at: number;
  last_used_at: number | null;
};

const iso = (ms: number) => new Date(ms).toISOString();

const toPasskey = (r: PasskeyRow, now: number): Passkey => ({
  id: r.id,
  label: r.label,
  createdAt: iso(r.created_at),
  lastUsedAt: r.last_used_at === null ? null : iso(r.last_used_at),
  usableAt: iso(r.created_at + PASSKEY_COOLING_MS),
  usable: r.created_at + PASSKEY_COOLING_MS <= now,
});

const SELECT = "select * from passkeys where user_id = ?1 order by created_at";

async function rowsOf(env: Env, userId: string): Promise<PasskeyRow[]> {
  const { results } = await stmt(env.DB, SELECT)
    .bind(userId)
    .all<PasskeyRow>();
  return results;
}

export async function listPasskeys(
  env: Env,
  userId: string,
  now = Date.now(),
): Promise<Passkey[]> {
  return (await rowsOf(env, userId)).map((r) => toPasskey(r, now));
}

const usable = (rows: PasskeyRow[], now: number) =>
  rows.filter((r) => r.created_at + PASSKEY_COOLING_MS <= now);

/** 409 no_passkey / passkey_cooling unless the member has a passkey that may confirm; returns those. */
async function requireUsable(
  env: Env,
  userId: string,
  now: number,
): Promise<PasskeyRow[]> {
  const rows = await rowsOf(env, userId);
  if (rows.length === 0)
    throw new ApiError("no_passkey", "Add a passkey in your settings first");
  const ok = usable(rows, now);
  if (ok.length === 0)
    throw new ApiError(
      "passkey_cooling",
      "A new passkey can approve 24 hours after it is added",
      { usableAt: iso(Math.min(...rows.map((r) => r.created_at)) + PASSKEY_COOLING_MS) },
    );
  return ok;
}

// ---------------------------------------------------------------- challenges

export type Kind = "register" | "pick" | "settings" | "remove";

const UPSERT_CHALLENGE = `insert into pick_assertions (id, user_id, kind, scope, binding, challenge, expires_at, used_at, created_at)
  values (?1, ?2, ?3, ?4, ?5, ?6, ?7, null, ?8)
  on conflict (user_id, scope) do update set
    id = excluded.id, kind = excluded.kind, binding = excluded.binding,
    challenge = excluded.challenge, expires_at = excluded.expires_at,
    used_at = null, created_at = excluded.created_at`;

/** Issues (replacing any earlier challenge of the scope) a challenge; 429 past the budget. */
async function issue(
  env: Env,
  userId: string,
  kind: Kind,
  scope: string,
  binding: string,
  now: number,
): Promise<{ challenge: string; expiresAt: number }> {
  const taken = await takeAll(env, [
    [
      `pk:ch:${userId}`,
      CHALLENGE_BUDGET,
      counterBucket("tenMin", now),
    ],
  ]);
  if (taken !== -1)
    throw new ApiError(
      "rate_limited",
      "Too many passkey prompts. Wait a few minutes.",
      undefined,
      { "retry-after": "600" },
    );
  const challenge = newChallenge();
  const expiresAt = now + PASSKEY_CHALLENGE_TTL_S * 1000;
  await stmt(env.DB, UPSERT_CHALLENGE)
    .bind(newId(), userId, kind, scope, binding, challenge, expiresAt, now)
    .run();
  return { challenge, expiresAt };
}

/** Options for navigator.credentials.get(), as JSON. */
async function requestOptions(
  env: Env,
  userId: string,
  kind: Kind,
  scope: string,
  binding: string,
  now: number,
): Promise<PasskeyChallenge> {
  const allow = await requireUsable(env, userId, now);
  const { challenge, expiresAt } = await issue(
    env,
    userId,
    kind,
    scope,
    binding,
    now,
  );
  return {
    options: {
      challenge,
      rpId: rpIdOf(env),
      timeout: PASSKEY_CHALLENGE_TTL_S * 1000,
      userVerification: "required",
      allowCredentials: allow.map((r) => ({
        type: "public-key",
        id: r.credential_id,
      })),
    },
    expiresAt: iso(expiresAt),
  };
}

type ChallengeRow = {
  id: string;
  kind: string;
  binding: string;
  challenge: string;
  expires_at: number;
  used_at: number | null;
};

/**
 * Verifies an assertion for the member's live challenge of `scope`, bound to
 * `binding`. Order: the challenge must exist, be unused and fresh (410
 * challenge_expired) and carry this binding (400); it is then consumed with a
 * compare-and-set (a lost race is 410); only then are the assertion and the
 * passkey checked (400 passkey_failed). A failed check burns the challenge.
 * Returns the passkey that signed.
 */
export async function verifyForScope(
  env: Env,
  userId: string,
  kind: Kind,
  scope: string,
  binding: string,
  assertion: unknown,
  now = Date.now(),
): Promise<{ passkeyId: string }> {
  const failed = (reason: string): never => {
    logWarn("passkey_failed", undefined, { reason, kind });
    throw new ApiError("passkey_failed", "The passkey could not be verified");
  };
  const row = await stmt(
    env.DB,
    "select id, kind, binding, challenge, expires_at, used_at from pick_assertions where user_id = ?1 and scope = ?2",
  )
    .bind(userId, scope)
    .first<ChallengeRow>();
  const expired = () =>
    new ApiError("challenge_expired", "Ask for a new passkey prompt");
  if (!row || row.kind !== kind || row.used_at !== null || row.expires_at <= now)
    throw expired();
  if (row.binding !== binding) return failed("binding");
  const res = await stmt(
    env.DB,
    "update pick_assertions set used_at = ?1 where id = ?2 and used_at is null and expires_at > ?1",
  )
    .bind(now, row.id)
    .run();
  if (!res.meta.changes) throw expired();
  const credId = assertionCredentialId(assertion);
  if (!credId) return failed("credential");
  const pk = await stmt(
    env.DB,
    "select * from passkeys where credential_id = ?1 and user_id = ?2",
  )
    .bind(credId, userId)
    .first<PasskeyRow>();
  if (!pk) return failed("unknown_passkey");
  if (pk.created_at + PASSKEY_COOLING_MS > now) return failed("cooling");
  let signCount: number;
  try {
    ({ signCount } = await verifyAssertion(
      assertion,
      {
        challenge: row.challenge,
        origin: appOrigin(env),
        rpId: rpIdOf(env),
      },
      { publicKey: pk.public_key, signCount: pk.sign_count },
    ));
  } catch (e) {
    return failed(e instanceof PasskeyError ? e.reason : "error");
  }
  // The counter moves only from the value just verified against: two uses of
  // one signature race here and one loses.
  const upd = await stmt(
    env.DB,
    "update passkeys set sign_count = ?1, last_used_at = ?2 where id = ?3 and sign_count = ?4",
  )
    .bind(signCount, now, pk.id, pk.sign_count)
    .run();
  if (!upd.meta.changes) return failed("sign_count_race");
  return { passkeyId: pk.id };
}

// -------------------------------------------------------------- registration

export type Account = { id: string; email: string; name?: string | null };

export async function registerBegin(
  env: Env,
  user: Account,
  now = Date.now(),
): Promise<PasskeyChallenge> {
  const rows = await rowsOf(env, user.id);
  if (rows.length >= MAX_PASSKEYS)
    throw new ApiError("conflict", `At most ${MAX_PASSKEYS} passkeys`);
  const { challenge, expiresAt } = await issue(
    env,
    user.id,
    "register",
    "register",
    "register",
    now,
  );
  const name = (await getSettings(env)).name;
  return {
    options: {
      challenge,
      rp: { id: rpIdOf(env), name },
      user: {
        id: btoa(user.id).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
        name: user.email,
        displayName: user.name || user.email,
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      timeout: PASSKEY_CHALLENGE_TTL_S * 1000,
      attestation: "none",
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "required",
      },
      excludeCredentials: rows.map((r) => ({
        type: "public-key",
        id: r.credential_id,
      })),
    },
    expiresAt: iso(expiresAt),
  };
}

export async function registerFinish(
  env: Env,
  user: Account,
  credential: unknown,
  label: string | undefined,
  ctx: Pick<ExecutionContext, "waitUntil"> | undefined,
  now = Date.now(),
): Promise<Passkey> {
  const row = await stmt(
    env.DB,
    "select id, kind, binding, challenge, expires_at, used_at from pick_assertions where user_id = ?1 and scope = 'register'",
  )
    .bind(user.id)
    .first<ChallengeRow>();
  if (!row || row.used_at !== null || row.expires_at <= now)
    throw new ApiError("challenge_expired", "Start adding the passkey again");
  const res = await stmt(
    env.DB,
    "update pick_assertions set used_at = ?1 where id = ?2 and used_at is null and expires_at > ?1",
  )
    .bind(now, row.id)
    .run();
  if (!res.meta.changes)
    throw new ApiError("challenge_expired", "Start adding the passkey again");
  let reg: Awaited<ReturnType<typeof verifyRegistration>>;
  try {
    reg = await verifyRegistration(credential, {
      challenge: row.challenge,
      origin: appOrigin(env),
      rpId: rpIdOf(env),
    });
  } catch (e) {
    logWarn("passkey_failed", undefined, {
      reason: e instanceof PasskeyError ? e.reason : "error",
      kind: "register",
    });
    throw new ApiError("passkey_failed", "The passkey could not be added");
  }
  const id = newId();
  const name = label?.trim() || "Passkey";
  try {
    await env.DB.batch([
      stmt(
        env.DB,
        `insert into passkeys (id, user_id, credential_id, public_key, alg, sign_count, label, created_at)
         select ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
         where (select count(*) from passkeys where user_id = ?2) < ?9`,
      ).bind(
        id,
        user.id,
        reg.credentialId,
        reg.publicKey,
        reg.alg,
        reg.signCount,
        name,
        now,
        MAX_PASSKEYS,
      ),
      audit(
        env,
        "passkey.add",
        { type: "user", id: user.id },
        userActor(user.id),
        {
          detail: { passkeyId: id },
          when: {
            sql: "exists (select 1 from passkeys where id = ?)",
            args: [id],
          },
        },
      ),
    ]);
  } catch (e) {
    if (String(e).includes("UNIQUE"))
      throw new ApiError("conflict", "That passkey is already registered");
    throw e;
  }
  const saved = await stmt(env.DB, "select * from passkeys where id = ?1")
    .bind(id)
    .first<PasskeyRow>();
  if (!saved) throw new ApiError("conflict", `At most ${MAX_PASSKEYS} passkeys`);
  const send = (async () => {
    const instance = (await getSettings(env)).name;
    await sendEmail(
      env,
      user.id,
      user.email,
      () =>
        passkeyAddedEmail({
          instance,
          recipient: user.email,
          appHost: env.APP_HOST,
          label: name,
        }),
      { kind: "passkey", instance },
    );
  })().catch((e) => logWarn("passkey_email_failed", e));
  if (ctx) ctx.waitUntil(send);
  else await send;
  return toPasskey(saved, now);
}

// ------------------------------------------------------------------- removal

export const removeScope = (id: string) => `remove:${id}`;

async function ownRow(env: Env, userId: string, id: string) {
  const r = await stmt(
    env.DB,
    "select * from passkeys where id = ?1 and user_id = ?2",
  )
    .bind(id, userId)
    .first<PasskeyRow>();
  if (!r) throw new ApiError("not_found", "Not found");
  return r;
}

export async function removeChallenge(
  env: Env,
  userId: string,
  id: string,
  now = Date.now(),
): Promise<PasskeyChallenge> {
  await ownRow(env, userId, id);
  return requestOptions(env, userId, "remove", removeScope(id), id, now);
}

/** Deletes the passkey; `assertion` is for removeChallenge, or the caller proved a fresh re-auth. */
export async function removePasskey(
  env: Env,
  userId: string,
  id: string,
  how: { assertion: unknown } | { reauth: true },
  now = Date.now(),
): Promise<void> {
  await ownRow(env, userId, id);
  if ("assertion" in how)
    await verifyForScope(env, userId, "remove", removeScope(id), id, how.assertion, now);
  await env.DB.batch([
    stmt(env.DB, "delete from passkeys where id = ?1 and user_id = ?2").bind(
      id,
      userId,
    ),
    audit(
      env,
      "passkey.remove",
      { type: "user", id: userId },
      userActor(userId),
      {
        detail: { passkeyId: id, passkeyVerified: "assertion" in how },
        when: {
          sql: "not exists (select 1 from passkeys where id = ?)",
          args: [id],
        },
      },
    ),
  ]);
}

// ------------------------------------------------------------------ settings

type SettingsRow = {
  ask_merge: number;
  ask_deploy: number;
  ask_delete: number;
  ask_share: number;
  ask_public: number;
  ask_command: number;
  every_pick: number;
};

const COLUMN: Record<AskAction, keyof SettingsRow> = {
  merge: "ask_merge",
  deploy: "ask_deploy",
  delete: "ask_delete",
  share: "ask_share",
  public: "ask_public",
  command: "ask_command",
};

export type Switches = {
  actions: Record<AskAction, boolean>;
  everyPick: boolean;
};

const DEFAULTS: Switches = {
  actions: {
    merge: true,
    deploy: true,
    delete: true,
    share: true,
    public: true,
    command: true,
  },
  everyPick: false,
};

const fromRow = (r: SettingsRow | null): Switches =>
  r
    ? {
        actions: Object.fromEntries(
          ASK_ACTIONS.map((a) => [a, a === "command" || r[COLUMN[a]] === 1]),
        ) as Record<AskAction, boolean>,
        everyPick: r.every_pick === 1,
      }
    : { actions: { ...DEFAULTS.actions }, everyPick: false };

export async function switchesOf(env: Env, userId: string): Promise<Switches> {
  return fromRow(
    await stmt(env.DB, "select * from passkey_settings where user_id = ?1")
      .bind(userId)
      .first<SettingsRow>(),
  );
}

export async function getPasskeySettings(
  env: Env,
  userId: string,
  now = Date.now(),
): Promise<PasskeySettings> {
  const [s, rows] = await Promise.all([
    switchesOf(env, userId),
    rowsOf(env, userId),
  ]);
  return {
    ...s,
    locked: ["command"],
    hasPasskey: rows.length > 0,
    hasUsablePasskey: usable(rows, now).length > 0,
  };
}

/** The exact change, canonical, as a challenge binding. */
export const settingsBinding = (s: Switches): string =>
  `${ASK_ACTIONS.map((a) => `${a}=${s.actions[a] ? 1 : 0}`).join(",")};every=${s.everyPick ? 1 : 0}`;

const SETTINGS_SCOPE = "settings";

const LOCKED_MESSAGE = "Always on: this runs code on your computer.";

const wanted = (b: PasskeySettingsPut): Switches => {
  if (!b.actions.command)
    throw new ApiError("bad_request", LOCKED_MESSAGE, { locked: "command" });
  return { actions: { ...b.actions }, everyPick: b.everyPick };
};

const turnsOff = (from: Switches, to: Switches): string[] => [
  ...ASK_ACTIONS.filter((a) => from.actions[a] && !to.actions[a]),
  ...(from.everyPick && !to.everyPick ? ["everyPick"] : []),
];

export async function settingsChallenge(
  env: Env,
  userId: string,
  body: PasskeySettingsPut,
  now = Date.now(),
): Promise<PasskeyChallenge> {
  const to = wanted(body);
  return requestOptions(
    env,
    userId,
    "settings",
    SETTINGS_SCOPE,
    settingsBinding(to),
    now,
  );
}

export async function putPasskeySettings(
  env: Env,
  userId: string,
  body: PasskeySettingsPut,
  now = Date.now(),
): Promise<PasskeySettings> {
  const to = wanted(body);
  const from = await switchesOf(env, userId);
  const off = turnsOff(from, to);
  let verified = false;
  if (off.length > 0) {
    await requireUsable(env, userId, now);
    if (body.assertion === undefined || body.assertion === null)
      throw new ApiError(
        "passkey_required",
        "Turning a switch off needs your passkey",
      );
    await verifyForScope(
      env,
      userId,
      "settings",
      SETTINGS_SCOPE,
      settingsBinding(to),
      body.assertion,
      now,
    );
    verified = true;
  }
  const on = ASK_ACTIONS.filter((a) => !from.actions[a] && to.actions[a]);
  const changed =
    off.length > 0 || on.length > 0 || from.everyPick !== to.everyPick;
  if (changed)
    await env.DB.batch([
      stmt(
        env.DB,
        `insert into passkey_settings (user_id, ask_merge, ask_deploy, ask_delete, ask_share, ask_public, ask_command, every_pick, updated_at)
         values (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8)
         on conflict (user_id) do update set
           ask_merge = excluded.ask_merge, ask_deploy = excluded.ask_deploy,
           ask_delete = excluded.ask_delete, ask_share = excluded.ask_share,
           ask_public = excluded.ask_public, ask_command = 1,
           every_pick = excluded.every_pick, updated_at = excluded.updated_at`,
      ).bind(
        userId,
        to.actions.merge ? 1 : 0,
        to.actions.deploy ? 1 : 0,
        to.actions.delete ? 1 : 0,
        to.actions.share ? 1 : 0,
        to.actions.public ? 1 : 0,
        to.everyPick ? 1 : 0,
        now,
      ),
      audit(
        env,
        "passkey.settings",
        { type: "user", id: userId },
        userActor(userId),
        {
          detail: {
            off,
            on: [
              ...on,
              ...(!from.everyPick && to.everyPick ? ["everyPick"] : []),
            ],
            passkeyVerified: verified,
          },
        },
      ),
    ]);
  return getPasskeySettings(env, userId, now);
}

// ------------------------------------------------------------------ asks

/**
 * `confirm` for a new ask: "passkey" when any of the people it reaches has a
 * passkey and their switches cover an action its options name (or "every
 * pick" is on). A member with no passkey cannot confirm, so their switches do
 * not apply until they add one (the Settings switches are disabled then).
 */
export async function confirmFor(
  env: Env,
  addressees: string[],
  options: Pick<AskOption, "action">[],
): Promise<"passkey" | undefined> {
  const named = new Set(
    options.flatMap((o) => (o.action ? [o.action] : [])),
  );
  if (addressees.length === 0) return undefined;
  const ids = JSON.stringify(addressees);
  const { results } = await stmt(
    env.DB,
    "select distinct user_id from passkeys where user_id in (select value from json_each(?1))",
  )
    .bind(ids)
    .all<{ user_id: string }>();
  for (const { user_id } of results) {
    const s = await switchesOf(env, user_id);
    if (s.everyPick || [...named].some((a) => s.actions[a])) return "passkey";
  }
  return undefined;
}

/** The ask a pick or challenge is for: its binding is the option. */
export const pickScope = (artifactId: string, commentId: string) =>
  `pick:${artifactId}:${commentId}`;

export async function pickChallenge(
  env: Env,
  userId: string,
  artifactId: string,
  commentId: string,
  optionId: string,
  now = Date.now(),
): Promise<PasskeyChallenge> {
  return requestOptions(
    env,
    userId,
    "pick",
    pickScope(artifactId, commentId),
    optionId,
    now,
  );
}

export const verifyPick = (
  env: Env,
  userId: string,
  artifactId: string,
  commentId: string,
  optionId: string,
  assertion: unknown,
  now = Date.now(),
) =>
  verifyForScope(
    env,
    userId,
    "pick",
    pickScope(artifactId, commentId),
    optionId,
    assertion,
    now,
  );
