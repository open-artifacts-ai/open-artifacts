import { R, SettingsPatchSchema } from "@oa/shared";
import { requireUser } from "../auth/authz.js";
import { orgCan } from "../auth/policy.js";
import { jsonBody } from "../http/body.js";
import { ApiError } from "../http/errors.js";
import { userActor } from "../services/audit.js";
import { patchSettings, settingsView } from "../services/members.js";
import { spacesOn } from "../services/spaces.js";
import type { AppType } from "./index.js";
import { requireManager } from "./members.js";

// C0, DEL, C1, and bidi controls (ALM, LRM/RLM, LRE..RLO, LRI..PDI).
const isControl = (cp: number) =>
  cp <= 0x1f ||
  (cp >= 0x7f && cp <= 0x9f) ||
  cp === 0x061c ||
  cp === 0x200e ||
  cp === 0x200f ||
  (cp >= 0x202a && cp <= 0x202e) ||
  (cp >= 0x2066 && cp <= 0x2069);

/** Trimmed instance name; 400 if blank or containing control characters. */
function cleanName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new ApiError("bad_request", "Name must not be blank");
  if ([...name].some((ch) => isControl(ch.codePointAt(0) ?? 0)))
    throw new ApiError("bad_request", "Name contains control characters");
  return name;
}

export function mountSettings(app: AppType): void {
  // Any member (owner/admin/member); guests get 404, anonymous 401.
  app.get(R.settings, async (c) => {
    const user = requireUser(c);
    if (!orgCan(user, "settings.read"))
      throw new ApiError("not_found", "Not found");
    return c.json(await settingsView(c.env, spacesOn(c.env)));
  });

  app.patch(R.settings, async (c) => {
    const actor = requireManager(c);
    const patch = await jsonBody(c, SettingsPatchSchema);
    if (patch.name !== undefined) patch.name = cleanName(patch.name);
    return c.json(
      await patchSettings(c.env, patch, {
        spaces: spacesOn(c.env),
        by: userActor(actor.id),
      }),
    );
  });
}
