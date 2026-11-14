/**
 * The bell and "For you" (#2512, slice 1), as OA Design drew it (screens v7):
 * a dropdown panel on desktop, a full screen on a phone (≤600px). The bell
 * reads Me.inbox; the list is R.meInbox, sorted by the server.
 */
import type { Inbox, InboxItem, Me } from "@oa/shared";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@oa/ui/shadcn";
import { useNavigate } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";
import {
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useThreads } from "../api/comments";
import { useMe } from "../auth/useMe";
import { toast } from "../layout/toast";
import { AskBlock, asksForMe, showsAskBody } from "../viewer/comments/asks";
import { Markdown } from "../viewer/comments/Markdown";
import {
  useDropItem,
  useInbox,
  useLater,
  useMarkRead,
  useMute,
  useReadAll,
} from "./api";
import {
  askComment,
  backText,
  bellName,
  bellState,
  canLater,
  contextLine,
  safePath,
  unread,
  waitMs,
  waitText,
} from "./model";

/** Settings › Notifications (today the email switch; slice 2 adds For you's). */
export const FOR_YOU_SETTINGS = "/settings/notifications";
export const PHONE = "(max-width: 600px)";

const useMedia = (q: string) =>
  useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(q);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(q).matches,
    () => false,
  );

/**
 * The bell, in the app header and the viewer's title bar. Absent when Me has
 * no `inbox` (a server without For you). `className` sizes it to its bar.
 */
export function ForYouBell({ className = "" }: { className?: string }) {
  const state = useMe();
  const me = state.status === "authed" ? state.me : null;
  const [open, setOpen] = useState(false);
  const inbox = useInbox(open && !!me?.inbox);
  const phone = useMedia(PHONE);
  if (!me?.inbox) return null;
  const b = bellState(inbox.data?.counts ?? me.inbox);
  const trigger = (
    <BellButton
      count={b.count}
      dot={b.dot}
      name={bellName(b)}
      className={className}
    />
  );
  const panel = inbox.data ? (
    <ForYouPanel data={inbox.data} phone={phone} close={() => setOpen(false)} />
  ) : (
    <Loading phone={phone} close={() => setOpen(false)} />
  );
  if (phone)
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>{trigger}</DialogTrigger>
        <DialogContent
          showCloseButton={false}
          aria-describedby={undefined}
          data-for-you=""
          className="top-0 left-0 flex h-dvh max-h-none w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-y-auto rounded-none border-0 bg-[var(--oa-surface)] p-0 sm:max-w-none data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100"
        >
          {panel}
        </DialogContent>
      </Dialog>
    );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        data-for-you=""
        aria-labelledby="oa-for-you-title"
        className="max-h-[min(640px,calc(100dvh-80px))] w-[380px] max-w-[calc(100vw-16px)] overflow-y-auto border-[var(--oa-border)] bg-[var(--oa-surface)] p-0 text-[var(--oa-text)] shadow-[var(--oa-shadow-2)]"
      >
        {panel}
      </PopoverContent>
    </Popover>
  );
}

const BELL_PATH =
  "M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7M10 20a2 2 0 0 0 4 0";

function BellButton({
  count,
  dot,
  name,
  className,
  ...props
}: {
  count: number;
  dot: boolean;
  name: string;
} & ComponentProps<"button">) {
  return (
    <button
      type="button"
      aria-label={name}
      data-for-you-bell=""
      data-count={count || undefined}
      data-dot={dot || undefined}
      {...props}
      className={`relative grid size-[30px] flex-none cursor-pointer place-items-center rounded-[8px] border border-[var(--oa-border)] bg-[var(--oa-surface)] text-[var(--oa-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--oa-focus)] data-[state=open]:border-[var(--oa-accent)] data-[state=open]:bg-[var(--oa-accent-soft)] ${className}`}
    >
      <svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d={BELL_PATH} />
      </svg>
      {count > 0 && (
        <span
          aria-hidden="true"
          data-bell-count=""
          className="absolute -top-[6px] -right-[6px] grid h-[17px] min-w-[17px] place-items-center rounded-[9px] bg-[var(--oa-warning)] px-1 text-[10.5px] leading-none font-bold text-[var(--oa-surface)]"
        >
          {count}
        </span>
      )}
      {dot && (
        <span
          aria-hidden="true"
          data-bell-dot=""
          className="absolute -top-[3px] -right-[3px] block size-[9px] rounded-full border-2 border-[var(--oa-bg)] bg-[var(--oa-accent)]"
        />
      )}
    </button>
  );
}

const LINK =
  "cursor-pointer border-0 bg-transparent p-0 text-[13px] font-normal text-[var(--oa-accent-fg)] underline";
const GROUP =
  "m-0 flex items-center justify-between border-t border-[var(--oa-divider)] bg-[var(--oa-sunken)] px-3.5 py-1.5 font-[family-name:var(--oa-font-mono)] text-[11.5px] font-medium tracking-[.06em] text-[var(--oa-text-muted)] uppercase";
const CHIP =
  "inline-flex items-center gap-1 rounded-full px-[7px] py-px font-[family-name:var(--oa-font-mono)] text-[11.5px] font-medium whitespace-nowrap";
const BTN =
  "relative z-[1] inline-flex h-7 cursor-pointer items-center rounded-[7px] border px-2.5 text-[12.5px] font-semibold whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-[var(--oa-focus)] max-[600px]:h-8";
const CLOSE =
  "grid size-11 cursor-pointer place-items-center border-0 bg-transparent text-[18px] text-[var(--oa-text-2)]";

/**
 * Item hrefs go through the router, and only when they stay on this origin
 * (the contract refuses others; this checks again). The panel closes first.
 */
function useGo(close: () => void) {
  const navigate = useNavigate();
  return (e: MouseEvent, href: string) => {
    const to = safePath(href);
    if (!to) {
      e.preventDefault();
      return;
    }
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    e.preventDefault();
    close();
    void navigate({ href: to });
  };
}

function Header({
  phone,
  close,
  children,
}: {
  phone: boolean;
  close: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className={`flex flex-none items-center gap-2 px-3.5 ${phone ? "sticky top-0 z-[2] h-12 border-b border-[var(--oa-divider)] bg-[var(--oa-surface)]" : "py-2.5"}`}
    >
      {children}
      {phone && (
        <button
          type="button"
          aria-label="Close"
          onClick={close}
          className={CLOSE}
        >
          <span aria-hidden="true">×</span>
        </button>
      )}
    </div>
  );
}

const TITLE = "m-0 flex-1 text-[length:var(--oa-text-md)] font-semibold";

function Title({ phone }: { phone: boolean }) {
  return phone ? (
    <DialogTitle className={TITLE}>For you</DialogTitle>
  ) : (
    <h2 id="oa-for-you-title" className={TITLE}>
      For you
    </h2>
  );
}

function SettingsLink({ close }: { close: () => void }) {
  const go = useGo(close);
  return (
    <a
      href={FOR_YOU_SETTINGS}
      className={LINK}
      onClick={(e) => go(e, FOR_YOU_SETTINGS)}
    >
      Settings
    </a>
  );
}

function Loading({ phone, close }: { phone: boolean; close: () => void }) {
  return (
    <div data-for-you-panel="" aria-busy="true">
      <Header phone={phone} close={close}>
        <Title phone={phone} />
        <SettingsLink close={close} />
      </Header>
      <div
        aria-hidden="true"
        className="mx-3.5 mb-3 h-24 animate-pulse rounded-md bg-[var(--oa-sunken)] motion-reduce:animate-none"
      />
    </div>
  );
}

function ForYouPanel({
  data,
  phone,
  close,
}: {
  data: Inbox;
  phone: boolean;
  close: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [showLater, setShowLater] = useState(false);
  const readAll = useReadAll();
  const opened = data.needsYou.find((x) => x.id === openId && askComment(x));
  // The opened ask went away (answered elsewhere): back to the list.
  useEffect(() => {
    if (openId && !opened) setOpenId(null);
  }, [openId, opened]);
  if (opened)
    return (
      <AskView
        item={opened}
        phone={phone}
        close={close}
        back={() => setOpenId(null)}
      />
    );
  const { needsYou, later } = data;
  // A read "While you were away" has done its job: the updates are listed.
  const updates = data.updates.filter((x) => x.kind !== "away" || !x.readAt);
  const anyUnread = updates.some(unread);
  const firstBack = later[0]?.later;
  const header = (
    <Header phone={phone} close={close}>
      <Title phone={phone} />
      <SettingsLink close={close} />
    </Header>
  );
  if (needsYou.length + later.length + updates.length === 0)
    return (
      <div data-for-you-panel="">
        {header}
        <div className="px-[18px] py-7 text-center text-[var(--oa-text-2)]">
          <b className="mb-0.5 block text-[15.5px] text-[var(--oa-text)]">
            You're all caught up.
          </b>
          When an agent asks you something or someone replies to you, it shows
          here.
        </div>
      </div>
    );
  const row = (x: InboxItem, put?: boolean) => (
    <Row
      key={x.id}
      x={x}
      phone={phone}
      put={put}
      open={() => setOpenId(x.id)}
      close={close}
    />
  );
  return (
    <div data-for-you-panel="">
      {header}
      <section aria-labelledby="oa-fy-needs">
        <h3 className={`${GROUP} ${phone ? "border-t-0" : ""}`}>
          <span id="oa-fy-needs">Needs you</span>
          <span>{needsYou.length}</span>
        </h3>
        {needsYou.length === 0 ? (
          <p className="m-0 px-[18px] py-4 text-center text-[15.5px] font-semibold">
            Nothing is waiting on you.
          </p>
        ) : (
          // The server's order: waiting, then approval, then plain; longest wait first.
          <ul className="m-0 list-none p-0">{needsYou.map((x) => row(x))}</ul>
        )}
      </section>
      <section aria-labelledby="oa-fy-updates">
        <h3 className={GROUP}>
          <span id="oa-fy-updates">Updates</span>
          {anyUnread ? (
            <button
              type="button"
              className={`${LINK} font-[family-name:var(--oa-font-sans)] tracking-normal normal-case`}
              onClick={() => readAll.mutate(undefined)}
            >
              Mark all read
            </button>
          ) : (
            <span>{updates.length}</span>
          )}
        </h3>
        <ul className="m-0 list-none p-0">
          {updates.map((x) => row(x))}
          {firstBack && (
            <li className="border-t border-[var(--oa-divider)]">
              <button
                type="button"
                aria-expanded={showLater}
                data-for-you-later-line=""
                onClick={() => setShowLater((s) => !s)}
                className={`grid w-full cursor-pointer grid-cols-[22px_1fr] gap-[9px] border-0 bg-transparent px-3.5 py-2.5 text-left text-[14px] text-[var(--oa-text-muted)] ${phone ? "min-h-14" : ""}`}
              >
                <Glyph>{showLater ? "▾" : "▸"}</Glyph>
                <span className="min-w-0">
                  <b className="block leading-[1.35] font-medium text-[var(--oa-text-2)]">
                    Later ({later.length})
                  </b>
                  <small className="mt-px block text-[12.5px]">
                    {backText(firstBack.until)}
                  </small>
                </span>
              </button>
            </li>
          )}
          {showLater && later.map((x) => row(x, true))}
        </ul>
      </section>
    </div>
  );
}

function Glyph({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className="grid size-[22px] flex-none place-items-center rounded-[6px] border border-[var(--oa-border)] text-[12px] text-[var(--oa-text-2)]"
    >
      {children}
    </span>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");

function Face({ x }: { x: InboxItem }) {
  const a = x.actor;
  if (a?.kind === "agent")
    return (
      <span
        aria-hidden="true"
        className="grid size-[22px] flex-none place-items-center rounded-[6px] bg-[var(--oa-accent)]"
      >
        <i className="block h-2 w-2.5 rounded-b-[5px] border-2 border-t-0 border-[var(--oa-accent-text)]" />
      </span>
    );
  if (a?.kind === "person")
    return (
      <span
        aria-hidden="true"
        className="grid size-[22px] flex-none place-items-center rounded-full border border-[var(--oa-border)] bg-[var(--oa-sunken)] text-[9.5px] font-semibold"
      >
        {initials(a.name)}
      </span>
    );
  return (
    <Glyph>{x.kind === "machine" ? "⌂" : x.kind === "away" ? "☾" : "•"}</Glyph>
  );
}

/** A waiting ask's calm mark: a clock and the server's duration. An approval: a key. */
function Urgency({ x }: { x: InboxItem }) {
  const ms = waitMs(x);
  if (ms !== undefined)
    return (
      <span
        data-for-you-wait=""
        className={`${CHIP} bg-[var(--oa-warning-soft)] text-[var(--oa-warning)]`}
      >
        <span aria-hidden="true">◷</span> {waitText(ms)}
      </span>
    );
  if (x.urgency === "approval")
    return (
      <span
        className={`${CHIP} bg-[var(--oa-warning-soft)] text-[var(--oa-warning)]`}
      >
        <KeyRound aria-hidden="true" className="size-3" /> Approval
      </span>
    );
  return null;
}

function Row({
  x,
  phone,
  put,
  open,
  close,
}: {
  x: InboxItem;
  phone: boolean;
  /** A row in the revealed Later list: muted, no actions. */
  put?: boolean;
  open: () => void;
  close: () => void;
}) {
  const go = useGo(close);
  const later = useLater();
  const markRead = useMarkRead();
  const mute = useMute();
  const needs = x.level === "needs_you";
  const isUnread = unread(x);
  const isAsk = askComment(x) !== null;
  const away = x.kind === "away";
  const agent =
    x.actor?.kind === "agent" && x.actor.agentId
      ? { id: x.actor.agentId, name: x.actor.name }
      : null;
  const page = x.artifact.id && !away ? x.artifact : null;
  const href = safePath(x.href);
  // The whole row is the target: the title's control stretches over it.
  const stretch =
    "cursor-pointer border-0 bg-transparent p-0 text-left text-inherit no-underline outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-[var(--oa-focus)] focus-visible:after:ring-inset";
  const title = (
    <>
      {x.text}
      {isUnread && !away && (
        <>
          <span
            aria-hidden="true"
            data-unread-dot=""
            className="ml-1.5 inline-block size-[7px] rounded-full bg-[var(--oa-accent)] align-[2px]"
          />
          <span className="sr-only">, unread</span>
        </>
      )}
    </>
  );
  const follow = (e: MouseEvent) => {
    if (isUnread) markRead.mutate([x.id]);
    go(e, x.href);
  };
  const urgency =
    needs && (waitMs(x) !== undefined || x.urgency === "approval");
  const acts =
    !put && needs && (urgency || x.backFromLater || x.kind === "machine");
  return (
    <li
      data-for-you-item={x.id}
      data-level={x.level}
      className={`relative grid grid-cols-[22px_1fr] gap-[9px] border-t border-[var(--oa-divider)] px-3.5 py-2.5 text-[14px] hover:bg-[var(--oa-sunken)] ${phone ? "min-h-14" : ""} ${put ? "text-[var(--oa-text-muted)]" : ""}`}
      style={
        needs && !put
          ? { boxShadow: "inset 3px 0 0 var(--oa-for-you-gold)" }
          : undefined
      }
    >
      <Face x={x} />
      <div className={`min-w-0 ${x.level === "update" ? "pr-7" : ""}`}>
        <b className="block leading-[1.35] font-semibold">
          {isAsk && !put ? (
            <button type="button" className={stretch} onClick={open}>
              {title}
            </button>
          ) : href && !away ? (
            <a href={href} className={stretch} onClick={follow}>
              {title}
            </a>
          ) : (
            title
          )}
        </b>
        <small className="mt-px block text-[12.5px] text-[var(--oa-text-muted)]">
          {contextLine(x)}
          {away && isUnread && (
            <>
              {" · "}
              {/* The contract can't fold rows yet: "Show them" marks the summary read, and the updates are listed below. */}
              <button
                type="button"
                className={`${LINK} relative z-[1] text-[12.5px]`}
                onClick={() => markRead.mutate([x.id])}
              >
                Show them
              </button>
            </>
          )}
        </small>
        {acts && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Urgency x={x} />
            {x.backFromLater && (
              <span
                className={`${CHIP} bg-[var(--oa-accent-soft)] text-[var(--oa-accent-fg)]`}
              >
                Back from later
              </span>
            )}
            {/* Review follows href to the approve page; nothing is approved from the list. */}
            {x.kind === "machine" && href && (
              <a
                href={href}
                onClick={follow}
                className={`${BTN} border-[var(--oa-accent)] bg-[var(--oa-accent)] text-[var(--oa-accent-text)] no-underline`}
              >
                Review
              </a>
            )}
            {canLater(x) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={`${BTN} border-[var(--oa-border)] bg-[var(--oa-surface)] font-medium text-[var(--oa-text)]`}
                  >
                    Later <span aria-hidden="true">▾</span>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-[180px]">
                  <DropdownMenuItem
                    onSelect={() => later.mutate({ id: x.id, until: "hour" })}
                  >
                    In an hour
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() =>
                      later.mutate({ id: x.id, until: "morning" })
                    }
                  >
                    Tomorrow morning
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}
      </div>
      {x.level === "update" && !away && (isUnread || page || agent) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="More actions"
              data-for-you-more=""
              className={`absolute z-[1] grid cursor-pointer place-items-center rounded-[6px] border-0 bg-transparent text-[var(--oa-text-muted)] outline-none hover:bg-[var(--oa-surface-2)] focus-visible:ring-2 focus-visible:ring-[var(--oa-focus)] ${phone ? "top-1.5 right-1.5 size-11" : "top-2 right-2 size-7"}`}
            >
              <span aria-hidden="true">⋯</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[200px]">
            {isUnread && (
              <DropdownMenuItem onSelect={() => markRead.mutate([x.id])}>
                Mark as read
              </DropdownMenuItem>
            )}
            {/* A mute stops push only: the row stays, with a quiet confirmation. */}
            {page && (
              <DropdownMenuItem
                onSelect={() =>
                  mute.mutate(
                    { kind: "page", id: page.id },
                    {
                      onSuccess: () =>
                        toast({
                          title: "Stopped following this page.",
                          tone: "neutral",
                        }),
                    },
                  )
                }
              >
                Stop following this page
              </DropdownMenuItem>
            )}
            {agent && (
              <DropdownMenuItem
                onSelect={() =>
                  mute.mutate(
                    { kind: "agent", id: agent.id },
                    {
                      onSuccess: () =>
                        toast({
                          title: `Muted ${agent.name}.`,
                          tone: "neutral",
                        }),
                    },
                  )
                }
              >
                Mute {agent.name}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </li>
  );
}

/** An ask row opened: its full card, the same one the page shows. Answering it returns to the list. */
function AskView({
  item,
  phone,
  close,
  back,
}: {
  item: InboxItem;
  phone: boolean;
  close: () => void;
  back: () => void;
}) {
  const page = item.artifact.id;
  const cid = askComment(item);
  // The card loads through the comments API; the item never carries the options.
  const threads = useThreads(page, !!page);
  const drop = useDropItem();
  const go = useGo(close);
  const backRef = useRef<HTMLButtonElement>(null);
  const thread = threads.data?.threads.find((t) =>
    t.comments.some((c) => c.id === cid),
  );
  const c = thread?.comments.find((x) => x.id === cid);
  const waits = thread ? asksForMe([thread]).length > 0 : null;
  const waited = useRef(false);
  const gone = threads.isSuccess && !c;
  // Answered here (the server's record, not the pick on its way), or gone: the row goes, back to the list.
  useEffect(() => {
    if (waits) waited.current = true;
    if ((waited.current && waits === false) || gone) {
      drop(item.id);
      back();
    }
  }, [waits, gone, drop, item.id, back]);
  useEffect(() => backRef.current?.focus(), []);
  const href = safePath(item.href);
  return (
    <section data-for-you-ask="" aria-labelledby="oa-for-you-title">
      <Header phone={phone} close={close}>
        {phone && <DialogTitle className="sr-only">For you</DialogTitle>}
        <button
          ref={backRef}
          id="oa-for-you-title"
          type="button"
          onClick={back}
          className="flex-1 cursor-pointer border-0 bg-transparent p-0 text-left text-[length:var(--oa-text-md)] font-semibold text-[var(--oa-text)] outline-none focus-visible:underline"
        >
          <span aria-hidden="true">← </span>For you
        </button>
        {href && (
          <a href={href} className={LINK} onClick={(e) => go(e, href)}>
            Open the page
          </a>
        )}
      </Header>
      <div className="flex flex-col gap-2 px-3 pt-2 pb-3">
        <span className="self-start empty:hidden">
          <Urgency x={item} />
        </span>
        {thread && c ? (
          <AskBlock
            artifactId={page}
            thread={thread}
            c={c}
            body={
              c.ask && showsAskBody(c.body, c.ask.question) ? (
                <div className="text-[13.5px] break-words text-[var(--oa-text-2)]">
                  <Markdown body={c.body} />
                </div>
              ) : undefined
            }
          />
        ) : (
          <div
            aria-hidden="true"
            className="h-40 animate-pulse rounded-md bg-[var(--oa-sunken)] motion-reduce:animate-none"
          />
        )}
      </div>
    </section>
  );
}
