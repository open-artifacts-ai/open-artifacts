import type { Hono } from "hono";
import type { AppEnv } from "../http/middleware.js";
import { mountOAuth } from "../mcp/oauth.js";
import { mountRuntime } from "../runtime/routes.js";
import { mountAdmin } from "./admin.js";
import { mountArtifacts } from "./artifacts.js";
import { mountAudit } from "./audit.js";
import { mountAuth } from "./auth.js";
import { mountBilling } from "./billing.js";
import { mountCodes } from "./codes.js";
import { mountDirectory } from "./directory.js";
import { mountMe } from "./me.js";
import { mountMembers } from "./members.js";
import { mountSearch } from "./search.js";
import { mountSettings } from "./settings.js";
import { mountShares } from "./shares.js";
import { mountShell } from "./shell.js";
import { mountSpaces } from "./spaces.js";
import { mountTokens } from "./tokens.js";
import { mountUploads } from "./uploads.js";
import { mountUsage } from "./usage.js";

export type AppType = Hono<AppEnv>;

// Route groups (one file per R.* group) are mounted here by later tasks.
// Called before the SPA fallback, which is always registered last.
export function mountRoutes(app: AppType): void {
  mountAuth(app);
  mountCodes(app);
  mountMe(app);
  mountMembers(app);
  mountSettings(app);
  mountSpaces(app);
  mountDirectory(app);
  mountArtifacts(app);
  mountUploads(app);
  mountShares(app);
  mountSearch(app);
  mountRuntime(app);
  mountTokens(app);
  mountUsage(app);
  mountAudit(app);
  mountBilling(app);
  mountAdmin(app);
  mountOAuth(app);
  // /a/:id(/v/:v) OG shells; other /a/* paths fall to the SPA fallback.
  mountShell(app);
}
