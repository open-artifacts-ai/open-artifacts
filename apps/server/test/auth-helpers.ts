import { env } from "cloudflare:workers";
import { newId } from "@oa/shared";
import type { Env } from "../src/env.js";

/** The Google client id the fake Google issuer and direct() agree on. */
export const CID = "cid.apps.googleusercontent.com";

/** A valid Ed25519 PKCS#8 private key (base64url), for broker-mode configs. */
export const TEST_BROKER_KEY =
  "MC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f";

/**
 * The test env with direct sign-in (Google direct transport and codes) on.
 * Codes need email sending (AuthConfig.emailCodes), so it carries a no-op
 * mailer; pass `EMAIL: undefined` for an install that can't send.
 */
export function direct(over: Partial<Env> = {}): Env {
  return {
    ...env,
    ...mailer().env,
    AUTH_PROVIDERS: "google,email",
    AUTH_DOMAINS: "a.com",
    AUTH_DOMAIN_JOIN: "member",
    GOOGLE_CLIENT_ID: CID,
    GOOGLE_CLIENT_SECRET: "s",
    INSTALL_ID: "inst-a",
    ...over,
  } as Env;
}

/** A code-only trial: domain codes on, Google off, Turnstile configured. */
export const trial = (over: Partial<Env> = {}): Env =>
  direct({
    AUTH_PROVIDERS: "email",
    EMAIL_CODE_DOMAIN: "on",
    TURNSTILE_SITE_KEY: "k",
    TURNSTILE_SECRET: "s",
    ...over,
  });

const tagged = () => crypto.randomUUID().slice(0, 8);

/** A unique address under `domain`, so tests sharing one D1 never collide. */
export const uniq = (local: string, domain = "a.com") =>
  `${local}-${tagged()}@${domain}`;

/** Inserts a user (optionally Google-linked, optionally not active). Returns its id. */
export async function seedUser(
  email: string,
  role: "owner" | "admin" | "member" | "guest",
  o: { googleSub?: string; tenant?: string; status?: string } = {},
): Promise<string> {
  const id = newId();
  await env.DB.prepare(
    "insert into users (id, email, name, role, created_at, status) values (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      email,
      email.split("@")[0],
      role,
      Date.now(),
      o.status ?? "active",
    )
    .run();
  if (o.googleSub)
    await env.DB.prepare(
      "insert into identities (provider, subject, tenant, user_id, created_at) values ('google', ?, ?, ?, ?)",
    )
      .bind(o.googleSub, o.tenant ?? "a.com", id, Date.now())
      .run();
  return id;
}

/** A share to `email` on a fresh artifact owned by a fresh member. */
export async function seedShare(email: string): Promise<string> {
  const owner = await seedUser(uniq("sharer"), "member");
  const art = newId();
  const now = Date.now();
  await env.DB.prepare(
    "insert into artifacts (id, owner_id, title, format, created_at, updated_at) values (?, ?, 't', 'markdown', ?, ?)",
  )
    .bind(art, owner, now, now)
    .run();
  await env.DB.prepare(
    "insert into shares (artifact_id, email, role, created_by, created_at) values (?, ?, 'viewer', ?, ?)",
  )
    .bind(art, email, owner, now)
    .run();
  return art;
}

export type SentMail = {
  from?: unknown;
  to: string;
  subject: string;
  text: string;
  html: string;
};

/** A fake `send_email` binding plus EMAIL_FROM; `codeFor` reads the last code sent to an address. */
export function mailer(fail = false) {
  const sent: SentMail[] = [];
  return {
    sent,
    env: {
      EMAIL_FROM: "noreply@mail.example.com",
      EMAIL: {
        async send(m: SentMail) {
          if (fail) throw new Error("E_SEND_FAILED");
          sent.push(m);
          return { messageId: `m${sent.length}` };
        },
      } as unknown as SendEmail,
    },
    codeFor(to: string): string {
      const m = [...sent].reverse().find((x) => x.to === to);
      const digits = m?.text.match(/\b(\d{4}) (\d{4})\b/);
      if (!digits) throw new Error(`no code sent to ${to}`);
      return `${digits[1]}${digits[2]}`;
    },
  };
}
