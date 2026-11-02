import { audit } from "../audit.js";
import { sealTo } from "../auth/seal.js";
import {
  mintTestAdminSession,
  TEST_ADMIN,
  TEST_ADMIN_LABEL,
} from "../auth/test-admin.js";
import { ApiError } from "../errors.js";
import type { HandlerArgs } from "./handlers.js";
import type { RouteResult } from "./invoke.js";

/**
 * R28 (#1053): a fresh 1 h test admin session, its sid sealed to the
 * caller's key, so the plaintext sid never leaves this Worker. authorize
 * admits only the pinned staging-test-admin.yml OIDC caller; the checks here
 * repeat it so a mis-wired authz row still fails closed.
 */
export async function testAdminSession(a: HandlerArgs): Promise<RouteResult> {
  const p = a.principal;
  if (
    a.env.OA_ENV !== "staging" ||
    p.kind !== "oidc" ||
    p.oidcWorkflow !== "test-admin" ||
    a.surface.kind !== "http"
  )
    throw new ApiError("forbidden");
  const { recipientKey } = a.input.body as { recipientKey: string };
  const { sid, expiresAt } = await mintTestAdminSession(a.env, Date.now());
  const sealed = await sealTo(recipientKey, sid);
  await audit(a.env, {
    action: "test_admin.session",
    actor: p,
    outcome: "ok",
    route: "R28",
    surface: a.surface,
    detail: { identity: TEST_ADMIN_LABEL, sub: TEST_ADMIN.sub, expiresAt },
  });
  return { status: 201, body: { sealed, expiresAt }, headers: {} };
}
