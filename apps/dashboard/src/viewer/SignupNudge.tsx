import { Button } from "@oa/ui/shadcn";
import { useState } from "react";
import { useAuthProviders } from "../api/auth";
import { isEmbed } from "../embed";
import { DismissIcon } from "./SlowNotice";
import { ICON, SM } from "./ui";

/** Hosted sign-up entry point: no sign-up route in the app yet, so the public site. */
export const SIGNUP_URL = "https://open-artifacts.com";
export const NUDGE_COPY =
  "Shared with you on Open Artifacts. Publish your own, free.";

const KEY = "oa.signup-nudge.dismissed";
const keyFor = (email: string | null) => `${KEY}:${email ?? "anonymous"}`;

// Blocked storage (private mode, policy) throws: the strip still renders, and
// dismissal then lasts for the session through component state.
const wasDismissed = (k: string) => {
  try {
    return localStorage.getItem(k) === "1";
  } catch {
    return false;
  }
};
const remember = (k: string) => {
  try {
    localStorage.setItem(k, "1");
  } catch {
    // Session only.
  }
};

/**
 * #1564: under the viewer toolbar, a signed-out viewer or a guest on a hosted
 * install is invited to publish their own. Never for members or on self-host.
 * `hosted` is the signed-in install's flag; a signed-out viewer asks the
 * public sign-in providers instead (their /me is a 401).
 */
export function SignupNudge({
  authed,
  guest,
  hosted,
  email,
}: {
  authed: boolean;
  guest: boolean;
  hosted: boolean;
  email: string | null;
}) {
  const embed = isEmbed();
  const providers = useAuthProviders(!authed && !embed);
  const [gone, setGone] = useState(false);
  const k = keyFor(email);
  const isHosted = authed ? hosted : providers.data?.hosted === true;
  if (embed || !isHosted || (authed && !guest)) return null;
  if (gone || wasDismissed(k)) return null;
  return (
    <div className="oa-vnotice mx-auto my-3 w-[calc(100%-32px)] max-w-[680px]">
      <div
        role="status"
        className="flex items-center gap-2 rounded-md bg-[var(--oa-accent-soft)] py-1 pr-1 pl-3 text-[length:var(--oa-text-sm)] leading-[1.45] text-foreground max-[560px]:flex-wrap"
      >
        <span className="min-w-0 flex-1">{NUDGE_COPY}</span>
        <Button asChild variant="outline" size="xs" className={SM}>
          <a href={SIGNUP_URL} target="_blank" rel="noopener noreferrer">
            Get started
          </a>
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className={`flex-none ${ICON}`}
          aria-label="Dismiss"
          onClick={() => {
            remember(k);
            setGone(true);
          }}
        >
          {DismissIcon}
        </Button>
      </div>
    </div>
  );
}
