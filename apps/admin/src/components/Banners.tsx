import type { World } from "@oa/shared/provisioning";
import { fmtDay } from "./labels";

/** Token banners from the world (R27): expiring, or not working. */
export function TokenBanner({ world }: { world: World | undefined }) {
  const t = world?.provisioningToken;
  if (!t || t.status === "active") return null;
  if (t.status === "invalid")
    return (
      <p
        className="oa-banner oa-banner-danger"
        role="alert"
        data-testid="token-banner"
      >
        <strong>The provisioning token isn't working.</strong> Creates,
        upgrades, resumes and restores wait until it's replaced. Pausing and
        deleting still work.
      </p>
    );
  const days = t.daysLeft ?? 0;
  return (
    <p
      className="oa-banner oa-banner-warn"
      role="alert"
      data-testid="token-banner"
    >
      <strong>
        The provisioning token expires in {days} {days === 1 ? "day" : "days"}.
      </strong>{" "}
      Roll it and paste it into Secrets Store before{" "}
      {fmtDay(Date.now() + days * 86_400_000)}.
    </p>
  );
}

/** Shown on every screen when the panel is on production. */
export const ProductionBanner = () => (
  <p className="oa-banner oa-banner-prod" data-testid="prod-banner">
    <strong>Production.</strong> Changes here affect real workspaces.
  </p>
);
