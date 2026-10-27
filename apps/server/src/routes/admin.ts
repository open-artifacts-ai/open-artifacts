import { R } from "@oa/shared";
import { caller, capOfCaller, requireUser } from "../auth/authz.js";
import { authConfig } from "../auth/config.js";
import { orgCan } from "../auth/policy.js";
import { ApiError } from "../http/errors.js";
import { logInfo } from "../log.js";
import { audit } from "../services/audit.js";
import {
  type BrokerCheckResult,
  checkBrokers,
} from "../services/broker-check.js";
import type { AppType } from "./index.js";

// Instance administration (org owner).

/** What the audit row and the log keep of one result: no body, code or URL. */
const summary = (r: BrokerCheckResult) => ({
  ok: r.ok,
  status: r.status,
  transport: r.transport,
  ...(r.skipped ? { skipped: r.skipped } : {}),
  ...(r.error ? { error: r.error } : {}),
});

export function mountAdmin(app: AppType): void {
  // Proves the install reaches its brokers (services/broker-check.ts). The
  // org owner only: anyone else, admins included, gets 404. RL_AUTH per
  // install, one unit per broker request (RL_AUTH allows 20 a minute, so
  // about 10 checks); unbound (the test pool, dev): unlimited.
  app.post(R.adminBrokerCheck, async (c) => {
    const user = requireUser(c);
    if (!orgCan(user, "broker.check", { cap: capOfCaller(caller(c)) }))
      throw new ApiError("not_found", "Not found");
    const rl = c.env.RL_AUTH;
    if (rl) {
      const key = `broker-check:${authConfig(c.env).installKey}`;
      for (let i = 0; i < 2; i++)
        if (!(await rl.limit({ key })).success)
          throw new ApiError(
            "rate_limited",
            "Too many broker checks; wait a minute",
          );
    }
    const out = await checkBrokers(c.env);
    const detail = {
      auth: summary(out.auth),
      directory: summary(out.directory),
    };
    await audit(
      c.env,
      "auth.broker_check",
      { type: "directory", id: "brokers" },
      { kind: "system", id: null },
      { detail },
    ).run();
    logInfo("broker_check", {
      auth_ok: out.auth.ok,
      auth_status: out.auth.status,
      auth_transport: out.auth.transport,
      directory_ok: out.directory.ok,
      directory_status: out.directory.status,
      directory_transport: out.directory.transport,
    });
    return c.json(out);
  });
}
