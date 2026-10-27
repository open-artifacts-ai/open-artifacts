import { stmt } from "../db/stmt.js";
import { sendEmail } from "../email/send.js";
import {
  type DirectoryAlert,
  directoryAlertEmail,
} from "../email/templates.js";
import type { Env } from "../env.js";
import { getSettings } from "../services/members.js";

// The owner alert (P3 T13): one email to every active org owner. DirectorySync
// sends it for outages, a customer mismatch and break-glass; disconnect sends
// it too.

const OWNERS = `select email from users where role = 'owner' and status = 'active'`;

/** Every active org owner's address. */
export async function ownerEmails(env: Pick<Env, "DB">): Promise<string[]> {
  const { results } = await stmt(env.DB, OWNERS).all<{ email: string }>();
  return results.map((r) => r.email);
}

/** Sends `why` to `to` (default: every active owner). */
export async function alertOwners(
  env: Env,
  why: DirectoryAlert,
  to?: string[],
): Promise<void> {
  const emails = to ?? (await ownerEmails(env));
  if (!emails.length) return;
  const instance = (await getSettings(env)).name;
  await Promise.all(
    emails.map((email) =>
      sendEmail(
        env,
        null,
        email,
        () =>
          directoryAlertEmail({
            instance,
            recipient: email,
            appHost: env.APP_HOST,
            why,
          }),
        { kind: "directory", instance },
      ),
    ),
  );
}
