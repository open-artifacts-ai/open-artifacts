import {
  BUS_ROUTES,
  BusNameSchema,
  DeviceCodeRequestSchema,
  type DeviceCodeResponse,
  DeviceTokenRequestSchema,
  type DeviceTokenResponse,
  formatUserCode,
  isMachineToken,
  LIMITS,
  newDeviceSecret,
  newId,
  newMachineLabel,
  newMachineToken,
  newUserCode,
  normalizeUserCode,
} from "@oa/bus-protocol";
import { AUTH, BusRolePutSchema, type Member, R } from "@oa/shared";
import type { Context } from "hono";
import { canConnect } from "../auth/agents.js";
import { interactiveSession, requireUser } from "../auth/authz.js";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { jsonBody } from "../http/body.js";
import { ApiError, appOrigin, errorJson } from "../http/errors.js";
import type { AppEnv } from "../http/middleware.js";
import {
  checkFormCsrf,
  formCsrf,
  messagePage,
  pageResponse,
  sessionUser,
} from "../http/pages.js";
import { logInfo } from "../log.js";
import type { AppType } from "../routes/index.js";
import { ipKey } from "../runtime/routes.js";
import {
  busOn,
  deleteBusRole,
  listBusAgents,
  listBusMachines,
  listBusRoles,
  MAX_ACTIVE_MACHINES,
  putBusRole,
  revokeBusMachine,
} from "../services/bus.js";
import { getSettings } from "../services/members.js";
import { getUser } from "../services/users.js";
import { hmacSign, sha256Hex } from "../util/crypto.js";
import { renderApprove, renderApproved, renderEntry } from "./approve-page.js";
import {
  AUTHZ_AT_HEADER,
  busHubName,
  CONNECT_DO_PATH,
  MACHINE_ID_HEADER,
  MACHINE_LABEL_HEADER,
} from "./hub.js";

// The bus's Worker routes (#1291, design "Contracts: Local client to
// instance"). Every /bus route answers 404 while the bus is off (BUS_HUB
// unbound, or HOSTED=1 until #1299). /api/v1/bus/* are the dashboard's.

/** RL_ANON keys (30 per key per minute). */
export const RL_KEYS = {
  /** POST /bus/device, per client IP (IPv6 per /64). */
  device: "bus-dev:ip:",
  /** POST /bus/device/token, per client IP. */
  tokenIp: "bus-tok:ip:",
  /** POST /bus/device/token, per device code (its hash). */
  tokenCode: "bus-tok:dc:",
  /** POST /bus/approve step=decide, per signed-in member. */
  approve: "bus-approve:u:",
  /** POST /bus/approve step=code (typing a code), per member and per IP. */
  code: "bus-code:u:",
  codeIp: "bus-code:ip:",
} as const;

/** Outstanding (unexpired) device codes per install; a new code past it is 429. */
export const MAX_PENDING_CODES = 100;
/** Outstanding device codes one client IP may hold. */
export const CODES_PER_IP = 5;
/** A poll sooner than the interval (less this slack) answers 429 slow down. */
const POLL_SLACK_MS = 1000;
export const POLL_MIN_MS = LIMITS.devicePollIntervalSec * 1000 - POLL_SLACK_MS;
/** Long-expired codes purged per POST /bus/device. */
const PURGE_BATCH = 50;
/** last_used_at is written at most this often per machine. */
const LAST_USED_MS = 60_000;
const MAX_FORM_BYTES = 8 * 1024;
/** The approve form's CSRF scope (http/pages.ts formCsrf). */
export const APPROVE_SCOPE = "bus-approve";

const NO_STORE = { "cache-control": "no-store" };
/**
 * The approval page, shared with the client (`BUS_ROUTES.approve`): the
 * person types their code there, and no URL ever carries it (RFC 8628 §5.4).
 */
export const APPROVE_PATH = BUS_ROUTES.approve;

const COUNTRY = /^[A-Z]{2}$/;
// Controls, bidi and zero-width characters: they can disguise a name.
const UNSAFE = new RegExp(
  "[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2069\\ufeff]",
  "gu",
);

/**
 * Where a device request came from, for the confirm screen: the country
 * (cf.country) and a readable network name (cf.asOrganization, cleaned and
 * capped). Never the IP or an ASN number; null when unknown.
 */
export function originOf(req: Request): {
  country: string | null;
  network: string | null;
} {
  const cf = (req as { cf?: Record<string, unknown> }).cf ?? {};
  const cc = typeof cf.country === "string" ? cf.country.toUpperCase() : "";
  const org =
    typeof cf.asOrganization === "string"
      ? cf.asOrganization.replace(UNSAFE, "").replace(/\s+/g, " ").trim()
      : "";
  return {
    // T1 is Tor and XX unknown: no country there.
    country: COUNTRY.test(cc) && cc !== "T1" && cc !== "XX" ? cc : null,
    // A readable name only: not empty, not just digits or an "AS123" token.
    network:
      org.length > 0 && !/^(as)?\d+$/i.test(org) ? org.slice(0, 64) : null,
  };
}
const notFound = () => new ApiError("not_found", "Not found");

const clientIp = (c: Context<AppEnv>) =>
  ipKey(c.req.header("cf-connecting-ip") ?? "") ?? "unknown";

/**
 * RL_ANON under `key`: null when allowed; a 429 (or, unbound outside dev, a
 * 503: fail closed) otherwise.
 */
async function limited(
  env: Env,
  key: string,
  retryAfterSec = 60,
): Promise<Response | null> {
  const rl = env.RL_ANON as RateLimit | undefined;
  if (!rl)
    return env.ENVIRONMENT === "dev"
      ? null
      : errorJson(503, "internal", "Connecting machines is unavailable");
  if ((await rl.limit({ key })).success) return null;
  return errorJson(429, "rate_limited", "Too many requests", undefined, {
    "retry-after": String(retryAfterSec),
  });
}

// ------------------------------------------------------------ device flow

const PURGE_CODES = `delete from bus_device_codes where id in
  (select id from bus_device_codes indexed by bus_device_codes_expires_idx
    where expires_at < ?1 limit ?2)`;
// Under both caps in the same statement, so concurrent requests can't pass
// together. A subquery counts at most cap + 1 rows.
const INSERT_CODE = `insert into bus_device_codes
  (id, device_code_hash, user_code, label, ip_tag, created_at, expires_at,
    origin_country, origin_network)
  select ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?10, ?11
  where (select count(*) from (select 1 from bus_device_codes
      indexed by bus_device_codes_expires_idx where expires_at > ?6 limit ?8)) < ?8
    and (select count(*) from (select 1 from bus_device_codes
      indexed by bus_device_codes_ip_idx where ip_tag = ?5 and expires_at > ?6 limit ?9)) < ?9`;

async function deviceCode(c: Context<AppEnv>): Promise<Response> {
  const env = c.env;
  if (!busOn(env)) throw notFound();
  const ip = clientIp(c);
  const rl = await limited(env, RL_KEYS.device + ip);
  if (rl) return rl;
  const body = await jsonBody(c, DeviceCodeRequestSchema);
  const label = newMachineLabel(body.machine_label ?? "machine");
  // The IP is never stored: only its HMAC, for the per-IP share of the cap.
  const ipTag = await hmacSign(env.SESSION_SECRET, `bus-device-ip:${ip}`);
  const origin = originOf(c.req.raw);
  const now = Date.now();
  await stmt(env.DB, PURGE_CODES)
    .bind(now - 3_600_000, PURGE_BATCH)
    .run();
  for (let attempt = 0; attempt < 2; attempt++) {
    const secret = newDeviceSecret();
    const userCode = formatUserCode(newUserCode());
    try {
      const r = await stmt(env.DB, INSERT_CODE)
        .bind(
          newId(),
          await sha256Hex(secret),
          userCode,
          label,
          ipTag,
          now,
          now + LIMITS.deviceCodeTtlSec * 1000,
          MAX_PENDING_CODES,
          CODES_PER_IP,
          origin.country,
          origin.network,
        )
        .run();
      if (!r.meta.changes) {
        logInfo("bus_device_code_cap");
        return errorJson(
          429,
          "rate_limited",
          "Too many pending device codes",
          undefined,
          { "retry-after": "60" },
        );
      }
      const res: DeviceCodeResponse = {
        device_code: secret,
        user_code: userCode,
        // RFC 8628 5.4: never the code (#1319 refuses one); the person types
        // it. The configured origin, never the Host header.
        verification_uri: `${appOrigin(env)}${APPROVE_PATH}`,
        expires_in: LIMITS.deviceCodeTtlSec,
        interval: LIMITS.devicePollIntervalSec,
      };
      return c.json(res, 201, NO_STORE);
    } catch (e) {
      // A user-code collision (unique index): one more try with a new code.
      if (attempt === 1 || !/UNIQUE/i.test(String(e))) throw e;
    }
  }
  throw new ApiError("internal", "Could not create a device code");
}

const POLL = `update bus_device_codes set last_poll_at = ?2
  where device_code_hash = ?1 and expires_at > ?2
    and (last_poll_at is null or last_poll_at <= ?3)
  returning id, approved_at as approvedAt, denied_at as deniedAt`;
const LIVE_CODE =
  "select 1 as x from bus_device_codes where device_code_hash = ?1 and expires_at > ?2";
// The machine row only for an approved, unexpired code whose approver is
// still active and under the machine cap; the code row goes in the same
// batch, and only when this poll's insert made the machine (one redeem).
const REDEEM = `insert into bus_machines (id, user_id, label, token_hash, created_at)
  select ?1, d.user_id, d.label, ?2, ?3 from bus_device_codes d
  where d.id = ?4 and d.approved_at is not null and d.denied_at is null
    and d.user_id is not null and d.expires_at > ?3
    and exists (select 1 from users u where u.id = d.user_id and u.status = 'active')
    and (select count(*) from bus_machines m
      where m.user_id = d.user_id and m.revoked_at is null) < ?5`;
const DROP_REDEEMED = `delete from bus_device_codes
  where id = ?1 and exists (select 1 from bus_machines where id = ?2)`;
const AT_LIMIT = `select (select count(*) from bus_machines m
    where m.user_id = d.user_id and m.revoked_at is null) >= ?2 as full
  from bus_device_codes d join users u on u.id = d.user_id and u.status = 'active'
  where d.id = ?1`;
const DROP_CODE = "delete from bus_device_codes where id = ?1";

async function deviceToken(c: Context<AppEnv>): Promise<Response> {
  const env = c.env;
  if (!busOn(env)) throw notFound();
  const rl = await limited(env, RL_KEYS.tokenIp + clientIp(c));
  if (rl) return rl;
  const { device_code } = await jsonBody(c, DeviceTokenRequestSchema);
  const hash = await sha256Hex(device_code);
  // Per device code too, so one code can't be polled from many addresses.
  const rlCode = await limited(
    env,
    RL_KEYS.tokenCode + hash.slice(0, 32),
    LIMITS.devicePollIntervalSec,
  );
  if (rlCode) return rlCode;
  const now = Date.now();
  const row = await stmt(env.DB, POLL)
    .bind(hash, now, now - POLL_MIN_MS)
    .first<{
      id: string;
      approvedAt: number | null;
      deniedAt: number | null;
    }>();
  const reply = (r: DeviceTokenResponse) => c.json(r, 200, NO_STORE);
  if (!row) {
    const live = await stmt(env.DB, LIVE_CODE).bind(hash, now).first();
    if (!live) return reply({ status: "expired" });
    return errorJson(429, "rate_limited", "Polling too fast", undefined, {
      "retry-after": String(LIMITS.devicePollIntervalSec),
    });
  }
  if (row.deniedAt !== null) {
    await stmt(env.DB, DROP_CODE).bind(row.id).run();
    return reply({ status: "denied" });
  }
  if (row.approvedAt === null) return reply({ status: "pending" });
  const token = newMachineToken();
  const machineId = newId();
  const [made] = await env.DB.batch([
    stmt(env.DB, REDEEM).bind(
      machineId,
      await sha256Hex(token),
      now,
      row.id,
      MAX_ACTIVE_MACHINES,
    ),
    stmt(env.DB, DROP_REDEEMED).bind(row.id, machineId),
  ]);
  if (made?.meta.changes) {
    logInfo("bus_machine_created", { machineId });
    return reply({ status: "approved", machine_token: token });
  }
  const full = await stmt(env.DB, AT_LIMIT)
    .bind(row.id, MAX_ACTIVE_MACHINES)
    .first<{ full: number }>();
  if (full?.full)
    throw new ApiError(
      "conflict",
      "Machine limit reached; revoke a machine, then try again",
    );
  // The approver is gone, or another poll redeemed it: this code is spent.
  await stmt(env.DB, DROP_CODE).bind(row.id).run();
  return reply({ status: "expired" });
}

// ---------------------------------------------------------- approval page
//
// RFC 8628 5.4 (#1291 review): the verification URI never carries the code.
// GET /bus/approve shows one field; the person types the code their terminal
// printed. POST /bus/approve step=code: only a correct, pending, unexpired
// code shows the machine and Approve/Deny; a wrong one reveals nothing. The
// confirm form carries the code with a form token bound to it and to the
// session (step=decide). Code entry is limited per member and per IP.

const PENDING_CODE = `select label, created_at as createdAt,
    origin_country as country, origin_network as network
  from bus_device_codes
  where user_code = ?1 and expires_at > ?2 and approved_at is null and denied_at is null`;
// An undecided code that has run out: its own message (Design), nothing else.
const EXPIRED_CODE = `select 1 as x from bus_device_codes
  where user_code = ?1 and expires_at <= ?2 and approved_at is null and denied_at is null`;
const DECIDE = (column: "approved_at" | "denied_at") => `update bus_device_codes
  set ${column} = ?3, user_id = ?2
  where user_code = ?1 and expires_at > ?3 and approved_at is null and denied_at is null
    and exists (select 1 from users where id = ?2 and status = 'active')
  returning label`;

/** The code entry form's CSRF scope and handle (one form per session). */
const ENTRY_SCOPE = "bus-code";
const ENTRY_HANDLE = "entry";

export const ENTRY_ERRORS = {
  wrong:
    "That code doesn't match a request waiting for you. Check your terminal and type it again.",
  expired:
    "That code has expired. Run the setup on your machine again to get a new one.",
  limited: "Too many tries. Wait a few minutes, then type the code again.",
} as const;

/** The stored (formatted) code, or null when the input can't be one. */
const codeOf = (input: string | undefined): string | null => {
  const raw = input && input.length <= 32 ? normalizeUserCode(input) : null;
  return raw === null ? null : formatUserCode(raw);
};

const gonePage = () =>
  messagePage(
    "This code expired",
    "This code expired or was already used. Run the setup on your machine again to get a new code.",
    404,
  );
const membersOnly = () =>
  messagePage(
    "Only members can connect machines",
    "Ask an admin of this workspace to make you a member, then try again.",
    403,
  );
const tooMany = () =>
  messagePage("Too many requests", "Wait a minute, then try again.", 429);
const busOff = () => messagePage("Not found", "There is nothing here.", 404);
const pageExpired = () =>
  messagePage(
    "This page expired",
    `Open ${APPROVE_PATH} again and type the code from your terminal.`,
    403,
  );

/** RL_ANON under each key; true when any is over (or unbound outside dev). */
async function overLimit(env: Env, keys: string[]): Promise<boolean> {
  const rl = env.RL_ANON as RateLimit | undefined;
  if (!rl) return env.ENVIRONMENT !== "dev";
  for (const key of keys) if (!(await rl.limit({ key })).success) return true;
  return false;
}

const loginRedirect = () =>
  new Response(null, {
    status: 302,
    headers: {
      location: `${AUTH.login}?next=${encodeURIComponent(APPROVE_PATH)}`,
      "cache-control": "no-store",
    },
  });
const switchUrl = () =>
  `${AUTH.login}?next=${encodeURIComponent(APPROVE_PATH)}`;

/** A two-letter country as its English name ("DE" -> "Germany"), or null. */
function countryName(cc: string | null): string | null {
  if (!cc) return null;
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(cc) ?? cc;
  } catch {
    return cc;
  }
}

async function entryPage(
  env: Env,
  user: Member,
  status: number,
  typed = "",
  error?: keyof typeof ENTRY_ERRORS,
): Promise<Response> {
  return pageResponse(
    renderEntry({
      instanceHost: env.APP_HOST,
      userEmail: user.email,
      formAction: APPROVE_PATH,
      csrf: await formCsrf(env, ENTRY_SCOPE, user.id, ENTRY_HANDLE),
      switchUrl: switchUrl(),
      typed: typed.slice(0, 32),
      ...(error ? { error: ENTRY_ERRORS[error] } : {}),
    }),
    status,
  );
}

async function showEntry(c: Context<AppEnv>): Promise<Response> {
  const env = c.env;
  if (!busOn(env)) return busOff();
  const user = sessionUser(c);
  if (!user) return loginRedirect();
  if (!canConnect(user)) return membersOnly();
  return entryPage(env, user, 200);
}

async function postApprove(c: Context<AppEnv>): Promise<Response> {
  const env = c.env;
  if (!busOn(env)) return busOff();
  // The page's no-referrer policy makes browsers send `Origin: null`: the
  // signed form token and the SameSite=Lax cookie carry CSRF, as consent.
  if (c.req.header("sec-fetch-site") === "cross-site")
    return messagePage(
      "Can't connect this machine",
      "Cross-site request.",
      403,
    );
  const user = sessionUser(c);
  if (!user)
    return messagePage(
      "Signed out",
      `Your session ended. Sign in, then open ${APPROVE_PATH} again.`,
      401,
    );
  const len = Number(c.req.header("content-length") ?? Number.NaN);
  if (!(len <= MAX_FORM_BYTES))
    return messagePage("Can't connect this machine", "Invalid form.", 400);
  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch {
    return messagePage("Can't connect this machine", "Invalid form.", 400);
  }
  const one = (k: string): string | null => {
    const v = form.getAll(k);
    return v.length === 1 ? String(v[0]) : null;
  };
  const step = one("step");
  const csrf = one("csrf");
  if (!canConnect(user)) return membersOnly();
  if (step === "code") {
    if (
      csrf === null ||
      !(await checkFormCsrf(env, ENTRY_SCOPE, user.id, ENTRY_HANDLE, csrf))
    )
      return pageExpired();
    const typed = one("code") ?? "";
    if (
      await overLimit(env, [
        RL_KEYS.code + user.id,
        RL_KEYS.codeIp + clientIp(c),
      ])
    )
      return entryPage(env, user, 429, typed, "limited");
    const code = codeOf(typed);
    const now = Date.now();
    const row =
      code === null
        ? null
        : await stmt(env.DB, PENDING_CODE).bind(code, now).first<{
            label: string;
            createdAt: number;
            country: string | null;
            network: string | null;
          }>();
    if (!row || code === null) {
      const expired =
        code !== null &&
        (await stmt(env.DB, EXPIRED_CODE).bind(code, now).first()) !== null;
      return entryPage(env, user, 200, typed, expired ? "expired" : "wrong");
    }
    const settings = await getSettings(env);
    return pageResponse(
      renderApprove({
        instanceName: settings.name,
        instanceHost: env.APP_HOST,
        label: row.label,
        userCode: code,
        ageMs: now - row.createdAt,
        country: countryName(row.country),
        network: row.network,
        userEmail: user.email,
        formAction: APPROVE_PATH,
        csrf: await formCsrf(env, APPROVE_SCOPE, user.id, code),
        switchUrl: switchUrl(),
      }),
      200,
    );
  }
  if (step !== "decide")
    return messagePage("Can't connect this machine", "Invalid form.", 400);
  const code = codeOf(one("code") ?? undefined);
  if (
    code === null ||
    csrf === null ||
    !(await checkFormCsrf(env, APPROVE_SCOPE, user.id, code, csrf))
  )
    return pageExpired();
  if (await overLimit(env, [RL_KEYS.approve + user.id])) return tooMany();
  const decision = one("decision");
  if (decision !== "approve" && decision !== "deny")
    return messagePage("Can't connect this machine", "Invalid form.", 400);
  const now = Date.now();
  const row = await stmt(
    env.DB,
    DECIDE(decision === "approve" ? "approved_at" : "denied_at"),
  )
    .bind(code, user.id, now)
    .first<{ label: string }>();
  if (!row) return gonePage();
  logInfo(decision === "approve" ? "bus_device_approved" : "bus_device_denied");
  if (decision === "deny")
    return messagePage(
      "Machine not connected",
      `"${row.label}" was not connected. Nothing was added.`,
      200,
    );
  return pageResponse(
    renderApproved({
      instanceHost: env.APP_HOST,
      label: row.label,
      userEmail: user.email,
      busUrl: `${appOrigin(env)}${BUS_ROUTES.page}`,
    }),
    200,
  );
}

// ---------------------------------------------------------------- connect

const MACHINE_BY_HASH = `select id, user_id as userId, label, revoked_at as revokedAt,
    last_used_at as lastUsedAt from bus_machines where token_hash = ?1`;
const TOUCH_MACHINE = `update bus_machines set last_used_at = ?2
  where id = ?1 and revoked_at is null and (last_used_at is null or last_used_at <= ?3)`;
/**
 * A machine's first connect: last_used_at is what services/bus.ts finds a
 * member's hub by, so a revocation that commits after this request read the
 * row, but before this write, would skip the hub (no connected machine yet)
 * and the hub would then accept. The write is therefore the check: it lands
 * only while the row is unrevoked and the member still passes canConnect's
 * SQL floor (active, a team role, no restriction); 0 rows is 401. A
 * revocation after it finds the hub, and the hub refuses this upgrade
 * (authzAt <= its revokedAt).
 */
const FIRST_TOUCH = `update bus_machines set last_used_at = ?2
  where id = ?1 and revoked_at is null and last_used_at is null
    and exists (select 1 from users u where u.id = bus_machines.user_id
      and u.status = 'active' and u.role in ('owner', 'admin', 'member')
      and u.restricted_manual = 0 and u.restricted_sync = 0)`;
const BEARER = /^\s*Bearer\s+(\S+)\s*$/i;

const unauthorized = () =>
  errorJson(401, "unauthorized", "A valid machine token is required");

/**
 * GET /bus/connect: a WebSocket upgrade with `Authorization: Bearer
 * oa_machine_...`. The token must be a live bus_machines row (never a PAT or
 * an OAuth token), its member active and canConnect; anything else is 401.
 * The member's BusHub is picked from the token's row, never from anything
 * the client sends.
 */
async function connect(c: Context<AppEnv>): Promise<Response> {
  const env = c.env;
  if (!busOn(env) || !env.BUS_HUB) throw notFound();
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket")
    return errorJson(426, "bad_request", "Expected a WebSocket upgrade");
  // Stamped by the route gate before any read (enforcePolicy).
  const authzAt = c.var.authzAt ?? Date.now();
  const token = BEARER.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
  if (!isMachineToken(token)) return unauthorized();
  const m = await stmt(env.DB, MACHINE_BY_HASH)
    .bind(await sha256Hex(token))
    .first<{
      id: string;
      userId: string;
      label: string;
      revokedAt: number | null;
      lastUsedAt: number | null;
    }>();
  if (!m || m.revokedAt !== null) return unauthorized();
  const user = await getUser(env, m.userId);
  if (!user || !canConnect(user)) return unauthorized();
  const now = Date.now();
  if (m.lastUsedAt === null) {
    const first = await stmt(env.DB, FIRST_TOUCH).bind(m.id, now).run();
    if (first.meta.changes !== 1) return unauthorized();
  } else if (m.lastUsedAt <= now - LAST_USED_MS)
    c.executionCtx.waitUntil(
      stmt(env.DB, TOUCH_MACHINE)
        .bind(m.id, now, now - LAST_USED_MS)
        .run()
        .then(() => undefined),
    );
  const ns = env.BUS_HUB;
  const hub = ns.get(ns.idFromName(busHubName(user.id)));
  return hub.fetch(
    new Request(`https://bus.internal${CONNECT_DO_PATH}`, {
      headers: {
        Upgrade: "websocket",
        [MACHINE_ID_HEADER]: m.id,
        [MACHINE_LABEL_HEADER]: m.label,
        [AUTHZ_AT_HEADER]: String(authzAt),
      },
    }),
  );
}

// -------------------------------------------------------------- dashboard

export function mountBus(app: AppType): void {
  app.post(BUS_ROUTES.device, deviceCode);
  app.post(BUS_ROUTES.deviceToken, deviceToken);
  app.get(APPROVE_PATH, showEntry);
  app.post(APPROVE_PATH, postApprove);
  app.get(BUS_ROUTES.connect, connect);

  app.get(R.busMachines, async (c) => {
    const user = requireUser(c);
    return c.json({ machines: await listBusMachines(c.env, user.id) });
  });
  // In CAPPED_ALLOWED: cutting off a credential never sits behind a cap.
  app.delete(`${R.busMachines}/:id`, async (c) => {
    const user = requireUser(c);
    const id = c.req.param("id") ?? "";
    if (!(await revokeBusMachine(c.env, user.id, id))) throw notFound();
    return c.body(null, 204);
  });
  app.get(R.busAgents, async (c) => {
    const user = requireUser(c);
    if (!canConnect(user)) throw notFound();
    return c.json(await listBusAgents(c.env, user.id));
  });

  // #1296 role addresses. The gate allows mcp.connect; a write also takes a
  // person in a browser (never a PAT, an OAuth grant or a machine token), so
  // no AI agent can set, re-point or claim a role.
  app.get(R.busRoles, async (c) => {
    const user = requireUser(c);
    if (!canConnect(user)) throw notFound();
    return c.json(await listBusRoles(c.env, user.id));
  });
  app.put(R.busRoles, async (c) => {
    const user = roleWriter(c);
    const body = await jsonBody(c, BusRolePutSchema);
    // The bus's own name rules (reserved names) on top of the wire shape.
    if (!BusNameSchema.safeParse(body.name).success)
      throw new ApiError("bad_request", "Invalid role", { field: "name" });
    return c.json({
      role: await putBusRole(
        c.env,
        user.id,
        body.namespace,
        body.name,
        body.agentId,
      ),
    });
  });
  app.delete(`${R.busRoles}/:id`, async (c) => {
    const user = roleWriter(c);
    await deleteBusRole(c.env, user.id, c.req.param("id") ?? "");
    return c.body(null, 204);
  });
}

/** A role write's caller: canConnect, in an interactive cookie session (else 404). */
function roleWriter(c: Context<AppEnv>) {
  const user = requireUser(c);
  if (!canConnect(user) || !interactiveSession(c)) throw notFound();
  return user;
}
