// #2520, Design's screens C and D: the invite dialog lists each address with
// how it will log in (from the server, PROVISIONAL api/loginSettings.ts), and
// an owner's first invite asks who should be able to join. Without the login
// settings (an older server), Members keeps its one-address dialog.
import type { Me, MemberInvite, MemberInviteResult } from "@oa/shared";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@oa/ui/shadcn";
import { XIcon } from "lucide-react";
import { useId, useRef, useState } from "react";
import { ApiClientError } from "../api/client";
import { InviteUnreachableDetailsSchema } from "../api/contract";
import { billingContext, errorCopy } from "../api/errorCopy";
import {
  type LoginSettings,
  REACH_MAX,
  type ReachRow,
  useReach,
} from "../api/loginSettings";
import { useInviteMember, useRestoreMember } from "../api/queries";
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
import { useDomainJoin } from "./domainJoin";
import { Pill } from "./Login";
import { FIRST_INVITE, INVITE, reachLine } from "./loginCopy";
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

/**
 * The invite dialog on a server with login settings: an owner's first invite
 * starts with who should be able to join (screen D), then the addresses
 * (screen C).
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
  const [step, setStep] = useState<"who" | "list">(() =>
    owner && settings.firstInvite === "ask" && settings.scope !== "self_hosted"
      ? "who"
      : "list",
  );
  if (step === "who")
    return (
      <FirstInviteStep
        settings={settings}
        instance={me?.instance.name ?? ""}
        onClose={onClose}
        onNext={() => setStep("list")}
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

/** Screen D: invite-only by default; the domain needs a company address. */
export function FirstInviteStep({
  settings,
  instance,
  onClose,
  onNext,
}: {
  settings: LoginSettings;
  instance: string;
  onClose: () => void;
  onNext: () => void;
}) {
  const [pick, setPick] = useState<"only" | "domain">("only");
  const [error, setError] = useState<string | null>(null);
  const domain = settings.domain.unavailable ? null : settings.domain.name;
  const join = useDomainJoin({ onDone: onNext, onError: setError });
  const name = useId();
  const go = (withDomain: boolean) => {
    setError(null);
    // Recording that it was seen never holds the invite up.
    join.change(
      withDomain
        ? { domainJoin: true, firstInviteDone: true }
        : { firstInviteDone: true },
    );
    if (!withDomain) onNext();
  };
  const option = (
    value: "only" | "domain",
    title: string,
    line: string,
    disabled = false,
  ) => (
    <label
      className={`flex items-start gap-[var(--oa-space-3)] rounded-md border p-[var(--oa-space-3)] ${pick === value ? "border-primary" : "border-border"} ${disabled ? "opacity-60" : "cursor-pointer"}`}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={pick === value}
        disabled={disabled}
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
  return (
    <Modal
      onClose={join.busy ? () => {} : onClose}
      title={FIRST_INVITE.title(instance)}
      description={FIRST_INVITE.sub}
      footer={
        <>
          <Button
            variant="ghost"
            disabled={join.busy}
            onClick={() => go(false)}
          >
            {FIRST_INVITE.skip}
          </Button>
          <Button disabled={join.busy} onClick={() => go(pick === "domain")}>
            {FIRST_INVITE.next}
          </Button>
        </>
      }
    >
      <fieldset className="m-0 grid gap-[var(--oa-space-2)] border-0 p-0">
        <legend className="sr-only">{FIRST_INVITE.title(instance)}</legend>
        {option("only", FIRST_INVITE.only, FIRST_INVITE.onlyLine)}
        {domain
          ? option(
              "domain",
              FIRST_INVITE.domain(domain),
              FIRST_INVITE.domainLine,
            )
          : option(
              "domain",
              FIRST_INVITE.noDomain,
              FIRST_INVITE.noDomainLine,
              true,
            )}
      </fieldset>
      {error && (
        <p role="alert" className={`m-0 ${errorText}`}>
          {error}
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
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<Sent | null>(null);
  const sending = useRef(false);
  const reach = useReach(list, true);
  const rows = new Map<string, ReachRow>(
    (reach.data ?? []).map((r) => [r.email, r]),
  );

  /** Moves the draft's addresses into the list; true if all of it parsed. */
  const commit = (raw = draft): string[] => {
    const { ok, bad: rest } = split(raw, parse);
    const next = [...list];
    for (const v of ok) if (!next.includes(v)) next.push(v);
    const capped = next.slice(0, REACH_MAX);
    setList(capped);
    setDraft(rest.join(" "));
    setBad(rest.length > 0);
    return capped;
  };
  const held = (email: string) => rows.get(email)?.blocked != null;
  const pending = split(draft, parse).ok.filter((v) => !list.includes(v));
  const count = list.filter((v) => !held(v)).length + pending.length;

  const submit = async () => {
    if (sending.current) return;
    const all = commit();
    const out = all.filter((v) => !held(v));
    if (out.length === 0) return;
    sending.current = true;
    setBusy(true);
    setFailed({});
    const errors: Record<string, string> = {};
    const done: string[] = [];
    let last: Sent | null = null;
    for (const email of out) {
      const r = rows.get(email);
      try {
        if (r?.removed) {
          await restore.mutateAsync(r.removed.userId);
          last = null;
        } else {
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
        }
        done.push(email);
      } catch (e) {
        errors[email] = r?.removed
          ? restoreCopy(e, email)
          : inviteFailure(e, email, domains, me);
      }
    }
    sending.current = false;
    setBusy(false);
    setFailed(errors);
    const left = all.filter((v) => !done.includes(v));
    setList(left);
    if (done.length === 0) return;
    if (left.length === 0 && done.length === 1 && last) return setSent(last);
    toast({ title: INVITE.sent(done.length), tone: "success" });
    if (left.length === 0) onClose();
  };

  if (sent) return inviteSent(sent, sends, onClose);

  return (
    <Modal
      onClose={busy ? () => {} : onClose}
      title="Add a member"
      description={
        sends
          ? INVITE.header
          : "Open Artifacts doesn't send invitations. Add their email here, then send them the login link yourself."
      }
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
                row={rows.get(email)}
                role={role}
                error={failed[email]}
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
          <p id="oa-invite-join-as-line" className={`m-0 ${muted}`}>
            {INVITE.joinAsLine}
          </p>
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
  row,
  role,
  error,
  disabled,
  onRemove,
}: {
  email: string;
  row: ReachRow | undefined;
  role: JoinAs;
  error: string | undefined;
  disabled: boolean;
  onRemove: () => void;
}) {
  const pill = !row ? null : row.blocked ? (
    <Pill tone="warn">{INVITE.cantPill}</Pill>
  ) : row.removed ? (
    <Pill tone="plain">{INVITE.removedPill}</Pill>
  ) : (
    <Pill tone="plain">{role}</Pill>
  );
  return (
    <li
      data-address={email}
      className="flex items-start gap-[var(--oa-space-2)] border-0 border-t border-border py-[var(--oa-space-2)] first:border-t-0"
    >
      <div className="grid min-w-0 flex-1 gap-[2px]">
        <span className="text-[length:var(--oa-text-sm)] [overflow-wrap:anywhere]">
          {email}
        </span>
        {row && (
          <p
            className={`m-0 ${row.blocked ? "text-[length:var(--oa-text-xs)] text-[var(--oa-warning)]" : muted}`}
          >
            {reachLine(row)}
          </p>
        )}
        {error && (
          <p role="alert" className={`m-0 ${errorText}`}>
            {withPlanLink(error)}
          </p>
        )}
      </div>
      {pill}
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
