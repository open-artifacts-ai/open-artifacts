// #2520, Design's screens C and D: the invite dialog lists each address with
// how it will log in (from the server, PROVISIONAL api/loginSettings.ts), and
// an owner's first invite asks who should be able to join. Without the login
// settings (an older server), Members keeps its one-address dialog.
import {
  type Me,
  type MemberInvite,
  type MemberInviteResult,
  MemberRemovedDetailsSchema,
} from "@oa/shared";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@oa/ui/shadcn";
import { useQueries } from "@tanstack/react-query";
import { XIcon } from "lucide-react";
import { useId, useRef, useState } from "react";
import { ApiClientError } from "../api/client";
import { hasFeature, InviteUnreachableDetailsSchema } from "../api/contract";
import { billingContext, errorCopy } from "../api/errorCopy";
import {
  type InviteReach,
  type LoginSettings,
  markFirstInviteSeen,
  reachQuery,
  useSetLoginSettings,
} from "../api/loginSettings";
import { useInviteMember, useMembers, useRestoreMember } from "../api/queries";
import { trialEndsOn, trialWouldStart } from "../api/trial";
import { emailEnabled } from "../auth/emailEnabled";
import { inviteRefusedCopy, signInWith, useSignInDomains } from "../auth/reach";
import { useMe } from "../auth/useMe";
import { CopyLink } from "../layout/CopyLink";
import { Modal } from "../layout/Modal";
import { Notice } from "../layout/Notice";
import { PLAN_PAGE } from "../layout/PlanBanner";
import { toast } from "../layout/toast";
import { AppLink } from "../library/AppLink";
import { joinBody, useDomainJoin } from "./domainJoin";
import { Pill } from "./Login";
import {
  FIRST_INVITE,
  INVITE,
  reachLine,
  removedLine,
  saveLine,
} from "./loginCopy";
import { errorText, muted } from "./ui";

/**
 * "Choose a plan" in `text`, as a link to Plan and billing. Only the owner
 * wording of a plan refusal has those words (a member's says "choose a plan"
 * in lower case, as plain text).
 */
export function withPlanLink(text: string) {
  const at = text.indexOf("Choose a plan");
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <AppLink href={PLAN_PAGE} className="underline">
        Choose a plan
      </AppLink>
      {text.slice(at + "Choose a plan".length)}
    </>
  );
}

/** A refused invite, worded (member_removed is the caller's: it offers Restore). */
export const inviteFailure = (
  e: unknown,
  email: string,
  domains: string,
  me: Me | null,
): string => {
  // Directory sync removed them: it revives them when Workspace restores the account (Manager's ruling).
  if (e instanceof ApiClientError && e.code === "directory_managed")
    return "Removed by your Google Workspace. They come back if their Workspace account is restored.";
  // A lapsed guest can't be restored: a new share brings them back.
  if (e instanceof ApiClientError && e.code === "guest_lapsed")
    return `${email} was a guest whose access lapsed. Share an artifact with them to bring them back.`;
  // Nothing was created: Design's copy, not the server's message.
  const refused =
    e instanceof ApiClientError && e.code === "invite_unreachable"
      ? InviteUnreachableDetailsSchema.safeParse(e.details)
      : null;
  if (refused?.success)
    return inviteRefusedCopy(refused.data.reason, email, domains);
  if (!(e instanceof ApiClientError)) return "Couldn't add.";
  return e.code.startsWith("plan_") || e.code === "billing_unavailable"
    ? errorCopy(e, e.message, { ...billingContext(me), refused: "invite" })
    : e.message;
};

export type Sent = {
  email: string;
  emailed: boolean;
  /** signIn "uncertain" (titled "Invite sent", emailed or not). */
  uncertain: boolean;
  /** How they sign in, from the server (older servers omit it). */
  with: string | null;
};

/**
 * After one invite: who it went to, and the login link to pass on. A plain
 * function returning the Modal, so the dialog that sent it stays the same
 * element (focus and screen readers stay with it).
 */
export function inviteSent(
  { email, emailed, uncertain, with: method }: Sent,
  sends: boolean,
  onClose: () => void,
) {
  // location.origin is the app host, where sign-in starts.
  const url = location.origin;
  return (
    <Modal
      onClose={onClose}
      title={
        // Design (#800): an uncertain invite is "Invite sent", emailed or not.
        uncertain
          ? `Invite sent to ${email}`
          : emailed
            ? `Invitation sent to ${email}`
            : `${email} can now log in`
      }
      description={
        emailed
          ? `They can also log in at ${url} with ${method ?? "a one-time code"}.`
          : `Send them this link. They'll log in at ${url} with ${method ?? "a one-time code sent to that address"}.`
      }
      footer={<Button onClick={onClose}>Done</Button>}
    >
      {sends && !emailed && (
        <p role="status" className={errorText}>
          The email didn't send. Copy the link and share it yourself.
        </p>
      )}
      <CopyLink link={url} label="Login link" />
    </Modal>
  );
}

const useMeOrNull = () => {
  const state = useMe();
  return state.status === "authed" ? state.me : null;
};

type JoinAs = "member" | "guest";
const JOIN_AS: { value: JoinAs; label: string }[] = [
  { value: "member", label: "Member" },
  { value: "guest", label: "Guest" },
];

/** Addresses in `raw` (commas, semicolons, spaces or new lines), and what didn't parse. */
const split = (raw: string, parse: (v: string) => string | null) => {
  const ok: string[] = [];
  const bad: string[] = [];
  for (const part of raw.split(/[\s,;]+/)) {
    if (!part) continue;
    const v = parse(part);
    if (v) ok.push(v);
    else bad.push(part);
  }
  return { ok, bad };
};

const BAD_ADDRESS = "Enter a valid email address (ASCII only).";
/** At most this many addresses at once. */
const LIST_MAX = 50;

/**
 * The invite dialog on a server with login settings. The owner's first invite
 * starts with who should be able to join (screen D: nobody invited yet, the
 * join off, a provable domain, and the server says it wasn't answered), then
 * the addresses (screen C).
 */
export function InvitePeople({
  settings,
  parse,
  restoreCopy,
  onClose,
}: {
  settings: LoginSettings;
  parse: (raw: string) => string | null;
  restoreCopy: (e: unknown, email: string) => string;
  onClose: () => void;
}) {
  const me = useMeOrNull();
  const owner = me?.user.role === "owner" && me.auth?.cap == null;
  const members = useMembers();
  const invitedAny = (members.data ?? []).some(
    (m) => m.id !== me?.user.id && m.role !== "guest" && m.role !== "owner",
  );
  const ask =
    owner &&
    settings.editable &&
    !settings.autoJoin &&
    settings.provable !== null &&
    members.isSuccess &&
    !invitedAny &&
    !settings.firstInviteSeen;
  const [answered, setAnswered] = useState(false);
  const setSettings = useSetLoginSettings();
  if (ask && !answered && settings.provable)
    return (
      <FirstInviteStep
        settings={settings}
        domain={settings.provable}
        instance={me?.instance.name ?? ""}
        onClose={onClose}
        onNext={() => {
          setAnswered(true);
          // Recording it never holds the invite up; a failure asks again next time.
          markFirstInviteSeen().then(
            () => setSettings({ ...settings, firstInviteSeen: true }),
            () => {},
          );
        }}
      />
    );
  return (
    <InviteList
      me={me}
      parse={parse}
      restoreCopy={restoreCopy}
      onClose={onClose}
    />
  );
}

/** Screen D: invite-only by default; the other option turns the join on. */
export function FirstInviteStep({
  settings,
  domain,
  instance,
  onClose,
  onNext,
}: {
  settings: LoginSettings;
  domain: string;
  instance: string;
  onClose: () => void;
  onNext: () => void;
}) {
  const [pick, setPick] = useState<"only" | "domain">("only");
  const join = useDomainJoin({ onDone: onNext });
  const name = useId();
  const option = (value: "only" | "domain", title: string, line: string) => (
    <label
      className={`flex cursor-pointer items-start gap-[var(--oa-space-3)] rounded-md border p-[var(--oa-space-3)] ${pick === value ? "border-primary" : "border-border"}`}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={pick === value}
        disabled={join.busy}
        onChange={() => setPick(value)}
        className="mt-[3px] accent-[var(--oa-accent)]"
      />
      <span className="grid min-w-0 gap-[2px]">
        <b className="text-[length:var(--oa-text-sm)] font-medium [overflow-wrap:anywhere]">
          {title}
        </b>
        <span className={muted}>{line}</span>
      </span>
    </label>
  );
  const note = saveLine(join.state, join.unproven, settings.provable);
  return (
    <Modal
      onClose={join.busy ? () => {} : onClose}
      title={FIRST_INVITE.title(instance)}
      description={FIRST_INVITE.sub}
      footer={
        <>
          <Button variant="ghost" disabled={join.busy} onClick={onNext}>
            {FIRST_INVITE.skip}
          </Button>
          <Button
            disabled={join.busy}
            onClick={() =>
              pick === "domain"
                ? join.change(joinBody(settings, true))
                : onNext()
            }
          >
            {FIRST_INVITE.next}
          </Button>
        </>
      }
    >
      <fieldset className="m-0 grid gap-[var(--oa-space-2)] border-0 p-0">
        <legend className="sr-only">{FIRST_INVITE.title(instance)}</legend>
        {option("only", FIRST_INVITE.only, FIRST_INVITE.onlyLine)}
        {option("domain", FIRST_INVITE.domain(domain), FIRST_INVITE.domainLine)}
      </fieldset>
      {note && (
        <p
          role={note.error ? "alert" : "status"}
          className={`m-0 ${note.error ? errorText : muted}`}
        >
          {note.text}
        </p>
      )}
    </Modal>
  );
}

/** Screen C: the addresses, each with how it will log in. */
function InviteList({
  me,
  parse,
  restoreCopy,
  onClose,
}: {
  me: Me | null;
  parse: (raw: string) => string | null;
  restoreCopy: (e: unknown, email: string) => string;
  onClose: () => void;
}) {
  const sends = emailEnabled(me);
  const spaces = hasFeature(me, "spaces");
  const domains = useSignInDomains();
  const invite = useInviteMember();
  const restore = useRestoreMember();
  // #1836: decided when the dialog opens, so the date doesn't move under the owner.
  const [trial] = useState(() =>
    trialWouldStart(me) ? { endsOn: trialEndsOn() } : null,
  );
  const [list, setList] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [bad, setBad] = useState(false);
  const [role, setRole] = useState<JoinAs>("member");
  const [failed, setFailed] = useState<Record<string, string>>({});
  // A removed member's address (member_removed): Restore, as before (parity 1).
  const [removed, setRemoved] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<Sent | null>(null);
  const sending = useRef(false);
  const reach = useQueries({ queries: list.map(reachQuery) });
  const reaches = new Map<string, InviteReach>();
  list.forEach((email, i) => {
    const d = reach[i]?.data;
    if (d) reaches.set(email, d);
  });

  const commit = (raw = draft): string[] => {
    const { ok, bad: rest } = split(raw, parse);
    const next = [...list];
    for (const v of ok) if (!next.includes(v)) next.push(v);
    const capped = next.slice(0, LIST_MAX);
    setList(capped);
    setDraft(rest.join(" "));
    setBad(rest.length > 0);
    return capped;
  };
  /** Can't log in here: held, the rest still go. */
  const held = (email: string) => reaches.get(email)?.ways.length === 0;
  const pending = split(draft, parse).ok.filter((v) => !list.includes(v));
  const count =
    list.filter((v) => !held(v) && !removed[v]).length + pending.length;

  const submit = async () => {
    if (sending.current) return;
    const all = commit();
    const out = all.filter((v) => !held(v) && !removed[v]);
    if (out.length === 0) return;
    sending.current = true;
    setBusy(true);
    setFailed({});
    const errors: Record<string, string> = {};
    const gone: Record<string, string> = {};
    const done: string[] = [];
    let last: Sent | null = null;
    for (const email of out) {
      try {
        const res: MemberInviteResult = await invite.mutateAsync({
          email,
          // PROVISIONAL: "guest" is new to POST members (#2520).
          role: role as MemberInvite["role"],
        });
        last = {
          email,
          emailed: res.emailed,
          uncertain: res.signIn?.status === "uncertain",
          with: signInWith(res.signInMethods),
        };
        done.push(email);
      } catch (e) {
        const was =
          e instanceof ApiClientError && e.code === "member_removed"
            ? MemberRemovedDetailsSchema.safeParse(e.details)
            : null;
        if (!was?.success) {
          errors[email] = inviteFailure(e, email, domains, me);
          continue;
        }
        // The reach said removed, and the row said inviting lets them back
        // in: restore them. Otherwise ask first, as before (parity 1).
        if (!reaches.get(email)?.removed) {
          gone[email] = was.data.userId;
          continue;
        }
        try {
          await restore.mutateAsync(was.data.userId);
          last = null;
          done.push(email);
        } catch (r) {
          errors[email] = restoreCopy(r, email);
        }
      }
    }
    sending.current = false;
    setBusy(false);
    setFailed(errors);
    setRemoved((r) => ({ ...r, ...gone }));
    const left = all.filter((v) => !done.includes(v));
    setList(left);
    if (done.length === 0) return;
    if (left.length === 0 && done.length === 1 && last) return setSent(last);
    toast({ title: INVITE.sent(done.length), tone: "success" });
    if (left.length === 0) onClose();
  };

  const restoreOne = (email: string) => {
    const id = removed[email];
    if (!id) return;
    restore.mutate(id, {
      onSuccess: () => {
        toast({
          title: `${email} is restored. They can log in again.`,
          tone: "success",
        });
        setList((l) => l.filter((v) => v !== email));
        setRemoved(({ [email]: _, ...r }) => r);
      },
      onError: (e) =>
        setFailed((f) => ({ ...f, [email]: restoreCopy(e, email) })),
    });
  };

  if (sent) return inviteSent(sent, sends, onClose);

  return (
    <Modal
      onClose={busy || restore.isPending ? () => {} : onClose}
      title={INVITE.title}
      description={sends ? INVITE.header : INVITE.noEmail}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || count === 0} onClick={() => void submit()}>
            {INVITE.send(count)}
          </Button>
        </>
      }
    >
      <form
        className="grid min-w-0 gap-[var(--oa-space-3)]"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) commit();
          else void submit();
        }}
      >
        {/* Product: without email, the 30 days still shows, under the header. */}
        {!sends && <p className={`m-0 ${muted}`}>{INVITE.lasts}</p>}
        <Input
          type="text"
          inputMode="email"
          autoComplete="off"
          aria-label="Email"
          placeholder="name@example.com"
          className="text-[length:var(--oa-text-sm)]"
          value={draft}
          aria-invalid={bad}
          aria-describedby={bad ? "oa-invite-bad" : undefined}
          onChange={(e) => {
            const v = e.target.value;
            // A separator, or a pasted list: those addresses become rows.
            if (/[\s,;]/.test(v)) commit(v);
            else {
              setDraft(v);
              setBad(false);
            }
          }}
          onBlur={() => {
            if (draft.trim()) commit();
          }}
        />
        {bad && (
          <p id="oa-invite-bad" role="alert" className={`m-0 ${errorText}`}>
            {BAD_ADDRESS}
          </p>
        )}
        {list.length > 0 && (
          <ul aria-label="Addresses" className="m-0 grid min-w-0 list-none p-0">
            {list.map((email) => (
              <AddressRow
                key={email}
                email={email}
                reach={reaches.get(email)}
                role={role}
                error={failed[email]}
                removed={
                  removed[email]
                    ? {
                        line: `${email} was removed. Restore them to bring back their account and the ${spaces ? "personal " : ""}artifacts you haven't transferred. They come back with the access they had (no admin role) and log in again.`,
                        restore: () => restoreOne(email),
                        busy: restore.isPending,
                      }
                    : null
                }
                disabled={busy}
                onRemove={() => setList((l) => l.filter((v) => v !== email))}
              />
            ))}
          </ul>
        )}
        <div className="grid gap-[var(--oa-space-1)]">
          <span
            id="oa-invite-join-as"
            className="text-[length:var(--oa-text-sm)] font-medium"
          >
            {INVITE.joinAs}
          </span>
          <Select
            value={role}
            disabled={busy}
            onValueChange={(v) => setRole(v as JoinAs)}
          >
            <SelectTrigger
              aria-labelledby="oa-invite-join-as"
              aria-describedby="oa-invite-join-as-line"
              size="sm"
              className="w-full text-[length:var(--oa-text-sm)]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {JOIN_AS.map((r) => (
                <SelectItem
                  key={r.value}
                  value={r.value}
                  className="text-[length:var(--oa-text-sm)]"
                >
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div id="oa-invite-join-as-line" className="grid gap-[2px]">
            <p className={`m-0 ${muted}`}>{INVITE.joinAsLine}</p>
            <p className={`m-0 ${muted}`}>{INVITE.adminLater}</p>
          </div>
        </div>
        {trial && (
          <Notice tone="info" title="This starts your 30-day Team trial.">
            Trial ends {trial.endsOn}.
          </Notice>
        )}
        {/* Enter submits the form; the footer's button is outside it. */}
        <button type="submit" hidden tabIndex={-1} aria-hidden />
      </form>
    </Modal>
  );
}

function AddressRow({
  email,
  reach,
  role,
  error,
  removed,
  disabled,
  onRemove,
}: {
  email: string;
  /** Undefined while the server hasn't answered. */
  reach: InviteReach | undefined;
  role: JoinAs;
  error: string | undefined;
  removed: { line: string; restore: () => void; busy: boolean } | null;
  disabled: boolean;
  onRemove: () => void;
}) {
  const ways = reach?.ways;
  const cant = ways?.length === 0;
  const was = reach?.removed;
  const line =
    !reach || removed
      ? null
      : was
        ? removedLine(was.at)
        : reachLine(email, reach.ways);
  return (
    <li
      data-address={email}
      className="flex items-start gap-[var(--oa-space-2)] border-0 border-t border-border py-[var(--oa-space-2)] first:border-t-0"
    >
      <div className="grid min-w-0 flex-1 gap-[2px]">
        <span className="text-[length:var(--oa-text-sm)] [overflow-wrap:anywhere]">
          {email}
        </span>
        {line && (
          <p
            className={`m-0 ${cant ? "text-[length:var(--oa-text-xs)] text-[var(--oa-warning)]" : muted}`}
          >
            {line}
          </p>
        )}
        {removed && (
          <div role="alert" className="grid gap-[var(--oa-space-2)]">
            <p className={`m-0 text-[length:var(--oa-text-sm)]`}>
              {removed.line}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="justify-self-start"
              disabled={removed.busy}
              onClick={removed.restore}
            >
              Restore {email}
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className={`m-0 ${errorText}`}>
            {withPlanLink(error)}
          </p>
        )}
      </div>
      {reach &&
        !removed &&
        (cant ? (
          <Pill tone="warn">{INVITE.cantPill}</Pill>
        ) : was ? (
          <Pill tone="plain">{INVITE.removedPill}</Pill>
        ) : (
          <Pill tone="plain">{role}</Pill>
        ))}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={INVITE.remove(email)}
        disabled={disabled}
        onClick={onRemove}
      >
        <XIcon aria-hidden="true" />
      </Button>
    </li>
  );
}
