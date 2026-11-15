/**
 * #2590 slice 2, the guest side: the guest bar on a shared page and the
 * "Get your own" offer (in the bar's menu, and once after the guest's first
 * comment). Strings are OA Product's, word for word from the issue.
 */
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@oa/ui/shadcn";
import { MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ICON, SM } from "./ui";

/** Hosted: sign-up (the waitlist during the beta). OA Product, #2590. */
export const HOSTED_OFFER_URL = "https://signup.open-artifacts.app/";
/** Self-hosted, and the bar's "Open Artifacts" link: the public site. */
export const SELF_HOSTED_OFFER_URL = "https://open-artifacts.com";
export const OPEN_ARTIFACTS_URL = SELF_HOSTED_OFFER_URL;
export const offerUrl = (hosted: boolean) =>
  hosted ? HOSTED_OFFER_URL : SELF_HOSTED_OFFER_URL;

export const GUEST = {
  bar: (sender: string) => `Shared by ${sender} · You're a guest`,
  /** Not in the issue: no sender known (sharedBy null). PROVISIONAL. */
  barNoSender: "You're a guest",
  home: "Shared with you",
  offerTitle: "Pages like this, made by your own AI agent",
  offerBody:
    "Open Artifacts is where people and agents share their work. Free for 30 days.",
  getYourOwn: "Get your own",
  notNow: "Not now",
  /** The bar menu's name (OA Product). */
  menu: "Guest options",
} as const;

// One non-identifying key: an email in it would leak on a shared device.
const OFFERED = "oa.guest-offer.shown";
const offered = () => {
  try {
    return localStorage.getItem(OFFERED) === "1";
  } catch {
    return false;
  }
};
const markOffered = () => {
  try {
    localStorage.setItem(OFFERED, "1");
  } catch {
    // Session only.
  }
};

/** The bar above a shared page for a guest, in place of the breadcrumbs. */
export function GuestBar({
  sender,
  hosted,
}: {
  sender: string | null;
  hosted: boolean;
}) {
  return (
    <header
      data-guest-bar=""
      className="flex min-h-10 items-center gap-[14px] border-0 border-b border-border bg-[var(--oa-chrome)] px-5 max-[600px]:gap-3 max-[600px]:px-4 max-[600px]:py-1.5"
    >
      {/* The product, not this instance: a new tab, no tracking parameters. */}
      <a
        href={OPEN_ARTIFACTS_URL}
        target="_blank"
        rel="noopener"
        className="font-semibold whitespace-nowrap text-foreground no-underline"
      >
        Open Artifacts
      </a>
      <p className="m-0 min-w-0 flex-1 truncate text-[length:var(--oa-text-sm)] text-muted-foreground max-[600px]:whitespace-normal">
        {sender ? GUEST.bar(sender) : GUEST.barNoSender}
      </p>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={GUEST.menu}
            className={`flex-none ${ICON}`}
          >
            <MoreHorizontal aria-hidden="true" className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <a href={offerUrl(hosted)} target="_blank" rel="noopener">
              {GUEST.getYourOwn}
            </a>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}

/**
 * Once after the guest's first comment: the "Get your own" offer. Only when
 * this guest had no comment of their own when the page loaded (a later visit
 * after an earlier comment never offers), and never twice on this browser.
 */
export function useFirstCommentOffer(guest: boolean, mine: number | null) {
  const start = useRef<number | null>(null);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!guest || mine === null) return;
    if (start.current === null) {
      start.current = mine;
      return;
    }
    if (start.current === 0 && mine > 0 && !offered()) {
      markOffered();
      setShow(true);
    }
  }, [guest, mine]);
  return { show, dismiss: () => setShow(false) };
}

export function GuestOffer({
  hosted,
  onDismiss,
}: {
  hosted: boolean;
  onDismiss: () => void;
}) {
  return (
    <section
      data-guest-offer=""
      aria-labelledby="oa-guest-offer-title"
      className="oa-vnotice mx-auto my-3 w-[calc(100%-32px)] max-w-[680px]"
    >
      <div className="flex items-center gap-3 rounded-md border border-[var(--oa-accent)] bg-[var(--oa-accent-soft)] px-3 py-2 text-[length:var(--oa-text-sm)] leading-[1.45] text-foreground max-[600px]:flex-col max-[600px]:items-stretch max-[600px]:gap-2">
        <div className="min-w-0 flex-1">
          <h2
            id="oa-guest-offer-title"
            className="m-0 text-[length:var(--oa-text-sm)] font-semibold"
          >
            {GUEST.offerTitle}
          </h2>
          <p className="m-0">{GUEST.offerBody}</p>
        </div>
        <div className="flex flex-none items-center gap-2">
          <Button asChild variant="default" size="xs" className={SM}>
            <a href={offerUrl(hosted)} target="_blank" rel="noopener">
              {GUEST.getYourOwn}
            </a>
          </Button>
          <Button variant="ghost" size="xs" className={SM} onClick={onDismiss}>
            {GUEST.notNow}
          </Button>
        </div>
      </div>
    </section>
  );
}
