// The broker's Google client per env (design v7 4.3 step 4): the ID token's
// aud. Public values; the same as @oa/provision's BROKER_GOOGLE_CLIENT_ID
// (wfp.ts), which a node test pins (provision is not a runtime dependency).
import type { ProvisioningEnv } from "@oa/shared/provisioning";

export const BROKER_GOOGLE_CLIENT_ID: Readonly<
  Record<ProvisioningEnv, string>
> = Object.freeze({
  staging:
    "1032390278908-nmf0n63n51u57dtvanu7bphes1lpi6pk.apps.googleusercontent.com",
  prod: "206295999771-ntbp6nlf5ospa45ovc73aur4f05fpp5s.apps.googleusercontent.com",
});
