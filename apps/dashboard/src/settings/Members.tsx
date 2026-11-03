import {
  type Member,
  MemberInviteSchema,
  MemberRemovedDetailsSchema,
  type Role,
} from "@oa/shared";
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@oa/ui/shadcn";
import { useEffect, useRef, useState } from "react";
import { ApiClientError } from "../api/client";
import { hasFeature, InviteUnreachableDetailsSchema } from "../api/contract";
import { errorCopy } from "../api/errorCopy";
import {
  ALREADY_HANDLED,
  useInviteMember,
  useMembers,
  usePatchMember,
  useRemoveMember,
  useResetIdentity,
  useRestoreMember,
  useRunTransfer,
  useSetRestricted,
} from "../api/queries";
import { emailEnabled } from "../auth/emailEnabled";
import { useFrozen } from "../auth/permissions";
import {
  inviteRefusedCopy,
  inviteUncertainCopy,
  signInWith,
  useSignInDomains,
} from "../auth/reach";
import { useMe } from "../auth/useMe";
import { CopyLink } from "../layout/CopyLink";
import { LoadError } from "../layout/LoadError";
import { Modal } from "../layout/Modal";
import { Notice } from "../layout/Notice";
import {
  isReleased,
  personFirst,
  personInSentence,
  personName,
} from "../layout/person";
import { toast } from "../layout/toast";
import { UserAvatar } from "../layout/UserAvatar";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { relativeTime } from "../library/time";
import { ConfirmDialog } from "./ConfirmDialog";
import { clearDenied, denyMember, useDenied } from "./denied";
import {
  type Departed,
  ownerOnlySource,
  seesDeparted,
  useDeparted,
} from "./departed";
import { restrictionReason } from "./restriction";
import { movedCount, runAll, TransferDialog } from "./Transfer";
import { errorText, muted, ReadOnlyNote, SettingsCard, STACK } from "./ui";

type Assignable = "admin" | "member";
/** Owner is never offered, to anyone. */
const ROLES: { value: Assignable; label: string }[] = [
  { value: "admin", label: "Admin" },
  { value: "member", label: "Member" },
];

const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  guest: "Guest",
};

/** Trimmed, lowercased, ASCII-only email, or null. */
export const parseInviteEmail = (raw: string) => {
  const v = raw.trim().toLowerCase();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII check
  if (!/^[\x00-\x7f]+$/.test(v)) return null;
  const r = MemberInviteSchema.shape.email.safeParse(v);
  return r.success ? r.data : null;
};

function RoleSelect({
  label,
  value,
  placeholder,
  onChange,
  disabled,
}: {
  disabled?: boolean;
  label: string;
  value: Assignable | undefined;
  placeholder?: string;
  onChange: (role: Assignable) => void;
}) {
  return (
    <Select
      value={value ?? ""}
      disabled={disabled}
      onValueChange={(v) => onChange(v as Assignable)}
    >
      <SelectTrigger
        aria-label={label}
        size="sm"
        className="w-full text-[length:var(--oa-text-sm)]"
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent position="popper">
        {ROLES.map((r) => (
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
  );
}

function InviteDialog({ onClose }: { onClose: () => void }) {
  const state = useMe();
  const me = state.status === "authed" ? state.me : null;
  const sends = emailEnabled(me);
  const spaces = hasFeature(me, "spaces");
  const invite = useInviteMember();
  const domains = useSignInDomains();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Assignable>("member");
  const [error, setError] = useState<string | null>(null);
  // The address belongs to a removed member: offer Restore (parity 1).
  const [removed, setRemoved] = useState<{
    userId: string;
    email: string;
  } | null>(null);
  const restore = useRestoreMember();
  const [added, setAdded] = useState<{
    email: string;
    emailed: boolean;
    /** signIn "uncertain": they may not be able to sign in (warned inline). */
    uncertain: boolean;
    /** How they sign in, from the server (older servers omit it). */
    with: string | null;
  } | null>(null);
  // Set synchronously: `isPending` only turns true on the next render, so two
  // submits in one tick (a fast double Enter) would both pass that check.
  const sending = useRef(false);
  const submit = () => {
    if (sending.current || invite.isPending) return;
    const parsed = parseInviteEmail(email);
    if (!parsed) return setError("Enter a valid email address (ASCII only).");
    setError(null);
    setRemoved(null);
    sending.current = true;
    invite.mutate(
      { email: parsed, role },
      {
        onSettled: () => {
          sending.current = false;
        },
        onSuccess: (r) => {
          setAdded({
            email: parsed,
            emailed: r.emailed,
            uncertain: r.signIn?.status === "uncertain",
            with: signInWith(r.signInMethods),
          });
        },
        onError: (e) => {
          const gone =
            e instanceof ApiClientError && e.code === "member_removed"
              ? MemberRemovedDetailsSchema.safeParse(e.details)
              : null;
          if (gone?.success) return setRemoved({ ...gone.data, email: parsed });
          // Directory sync removed them: it revives them when Workspace restores the account (Manager's ruling).
          if (e instanceof ApiClientError && e.code === "directory_managed")
            return setError(
              `Removed by your Google Workspace. They come back if their Workspace account is restored.`,
            );
          // A lapsed guest can't be restored: a new share brings them back.
          if (e instanceof ApiClientError && e.code === "guest_lapsed")
            return setError(
              `${parsed} was a guest whose access lapsed. Share an artifact with them to bring them back.`,
            );
          // Nothing was created: Design's copy, not the server's message.
          const refused =
            e instanceof ApiClientError && e.code === "invite_unreachable"
              ? InviteUnreachableDetailsSchema.safeParse(e.details)
              : null;
          setError(
            refused?.success
              ? inviteRefusedCopy(refused.data.reason, parsed, domains)
              : e instanceof ApiClientError
                ? e.code.startsWith("plan_") || e.code === "billing_unavailable"
                  ? errorCopy(e, e.message, {
                      owner: me?.user.role === "owner" && me.auth?.cap == null,
                    })
                  : e.message
                : "Couldn't add.",
          );
        },
      },
    );
  };
  if (added) {
    // location.origin is the app host, where sign-in starts.
    const url = location.origin;
    return (
      <Modal
        onClose={onClose}
        title={
          // Design (#800): an uncertain invite is "Invite sent", emailed or not.
          added.uncertain
            ? `Invite sent to ${added.email}`
            : added.emailed
              ? `Invitation sent to ${added.email}`
              : `${added.email} can now sign in`
        }
        description={
          added.emailed
            ? `They can also sign in at ${url} with ${added.with ?? "a one-time code"}.`
            : `Send them this link. They'll sign in at ${url} with ${added.with ?? "a one-time code sent to that address"}.`
        }
        footer={<Button onClick={onClose}>Done</Button>}
      >
        {added.uncertain && (
          <Notice tone="warning" compact>
            {inviteUncertainCopy(added.email, domains)}
          </Notice>
        )}
        {sends && !added.emailed && (
          <p role="status" className={errorText}>
            The email didn't send. Copy the link and share it yourself.
          </p>
        )}
        <CopyLink link={url} label="Sign-in link" />
      </Modal>
    );
  }
  return (
    <Modal
      onClose={onClose}
      title="Add a member"
      description={
        sends
          ? `We'll email them a link to ${me?.instance.name}. They'll sign in with a one-time code.`
          : "Open Artifacts doesn't send invitations. Add their email here, then send them the sign-in link yourself."
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={invite.isPending} onClick={submit}>
            Add member
          </Button>
        </>
      }
    >
      <form
        id="oa-invite-form"
        className="grid gap-[var(--oa-space-3)]"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Input
          type="text"
          inputMode="email"
          autoComplete="off"
          aria-label="Email"
          placeholder="name@example.com"
          className="text-[length:var(--oa-text-sm)]"
          value={email}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "oa-invite-error" : undefined}
          onChange={(e) => setEmail(e.target.value)}
        />
        {removed && (
          <div
            role="alert"
            className="grid gap-[var(--oa-space-2)] text-[length:var(--oa-text-sm)]"
          >
            <p className="m-0">
              {removed.email} was removed. Restore them to bring back their
              account and the {spaces && "personal "}artifacts you haven't
              transferred. They come back with the access they had (no admin
              role) and sign in again.
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="justify-self-start"
              disabled={restore.isPending}
              onClick={() =>
                restore.mutate(removed.userId, {
                  onSuccess: () => {
                    toast({
                      title: `${removed.email} is restored. They can sign in again.`,
                      tone: "success",
                    });
                    onClose();
                  },
                  onError: (e) => {
                    setRemoved(null);
                    setError(restoreRefusal(e, removed.email));
                  },
                })
              }
            >
              Restore {removed.email}
            </Button>
          </div>
        )}
        {error && (
          <p id="oa-invite-error" role="alert" className={errorText}>
            {error}
          </p>
        )}
        <RoleSelect label="Role" value={role} onChange={setRole} />
      </form>
    </Modal>
  );
}

const lastSeen = (iso: string | null) => {
  if (!iso) return "Never signed in";
  const when = relativeTime(iso);
  return when ? `Active ${when}` : "Last active unknown";
};

/** Who, role, last seen, action; at <= 600px, who and role, then the rest. */
const ROW =
  "grid min-h-[52px] grid-cols-[minmax(0,1fr)_112px_136px_72px] items-center gap-[10px] border-0 border-t border-border py-[var(--oa-space-2)] max-[600px]:grid-cols-[minmax(0,1fr)_112px]";

/** The Restricted badge: warning-soft, unlike the neutral role badges. */
const RESTRICTED_BADGE =
  "border-transparent bg-[var(--oa-warning-soft)] text-[var(--oa-warning)]";

/**
 * Who may reset `m`'s Google link: linked to Google, never the owner, never
 * yourself. Only the owner resets another admin (the server enforces it too:
 * 403); that last rule is the one line to drop if it moves server-side only.
 */
const mayResetGoogle = (m: Member, you: boolean, owner: boolean) =>
  (m.identities ?? []).includes("google") &&
  m.role !== "owner" &&
  !you &&
  (m.role !== "admin" || owner);

/** Design's copy: role change and Remove on another admin's row. */
const ADMIN_ONLY = "Only the owner can change another admin's access.";
const RESET_ONLY = "Only the owner can reset another admin's Google link.";

/**
 * The email under the name, only when it adds something: the server's name
 * falls back to the email (effectiveName), and a released address never shows.
 */
const secondLine = (m: Member) =>
  m.name && m.name !== m.email && !isReleased(m) ? m.email : null;

function Row({
  m,
  you,
  spaces,
  owner,
  frozen,
}: {
  /** The plan locked the instance (cap "plan"): reads stay, every write control is off. */
  frozen: boolean;
  m: Member;
  you: boolean;
  /** The spaces feature: only the copy names spaces (parity 1 ungates the rest). */
  spaces: boolean;
  /** The viewer is the owner, uncapped: only they act on owner and admin rows. */
  owner: boolean;
}) {
  const denyAdmin = (id: string) => denyMember(id, ADMIN_ONLY);
  const patch = usePatchMember(denyAdmin, denyMember);
  const [confirm, setConfirm] = useState(false);
  const [moving, setMoving] = useState(false);
  const [restricting, setRestricting] = useState(false);
  const [lifting, setLifting] = useState(false);
  const remove = useRemoveMember(denyAdmin);
  const denied = useDenied(m.id);
  const setRestricted = useSetRestricted();
  const resetGoogle = useResetIdentity();
  const [resetting, setResetting] = useState(false);
  const canResetGoogle = mayResetGoogle(m, you, owner);
  const label = personName(m);
  // Another admin's (or the owner's) row, seen by anyone but the owner: read-only.
  const readOnly = !owner && (m.role === "admin" || m.role === "owner");
  const locked = m.role === "owner" || you || readOnly;
  const why = restrictionReason(m.restriction);
  const manual = m.restriction?.manual === true;
  const groups = m.restriction?.groups ?? [];
  // The manual flag only: active members, never owners, admins or guests.
  const canRestrict =
    m.role === "member" && (m.status ?? "active") === "active";
  const address = secondLine(m);
  const first = personFirst(m);
  return (
    <li className={ROW}>
      <div className="flex min-w-0 items-center gap-[10px]">
        <UserAvatar name={m.name} email={m.email} />
        <div className="min-w-0">
          <b className="flex min-w-0 items-center gap-[6px] font-medium">
            <span className="truncate">{label}</span>
            {you && <span className="text-muted-foreground"> (you)</span>}
            {why && (
              <Badge
                variant="outline"
                data-tone="warning"
                className={`flex-none max-[600px]:hidden ${RESTRICTED_BADGE}`}
              >
                Restricted
              </Badge>
            )}
          </b>
          {(address || why) && (
            <small className={`block truncate ${muted}`}>
              {address}
              {/* At <= 600px the badge and reason move to the control line. */}
              <span className="max-[600px]:hidden">
                {address && why ? " · " : null}
                {why}
              </span>
            </small>
          )}
        </div>
      </div>
      {locked ? (
        <Badge variant="outline" className="justify-self-start">
          {ROLE_LABEL[m.role]}
        </Badge>
      ) : (
        <RoleSelect
          label={`Role for ${label}`}
          value={m.role === "admin" || m.role === "member" ? m.role : undefined}
          placeholder="Guest"
          disabled={frozen}
          onChange={(role) => {
            clearDenied(m.id);
            patch.mutate({ id: m.id, role });
          }}
        />
      )}
      {/* Labelled inline: there is no column header at any width. */}
      <span className={muted}>
        {why && (
          <span className="mb-[4px] hidden items-center gap-[6px] max-[600px]:flex">
            <Badge
              variant="outline"
              data-tone="warning"
              className={RESTRICTED_BADGE}
            >
              Restricted
            </Badge>{" "}
            {why}
          </span>
        )}
        {lastSeen(m.lastSeenAt)}
      </span>
      {locked ? (
        <span />
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="justify-self-end"
              disabled={frozen}
              aria-label={`More for ${label}`}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                width="16"
                height="16"
                fill="currentColor"
              >
                <circle cx="3" cy="8" r="1.5" />
                <circle cx="8" cy="8" r="1.5" />
                <circle cx="13" cy="8" r="1.5" />
              </svg>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="text-[length:var(--oa-text-sm)]"
          >
            {m.personalArtifacts && (
              <DropdownMenuItem onSelect={() => setMoving(true)}>
                Transfer their artifacts
              </DropdownMenuItem>
            )}
            {canRestrict && (
              <DropdownMenuItem
                onSelect={() =>
                  manual ? setLifting(true) : setRestricting(true)
                }
              >
                {manual ? "Lift manual restriction…" : "Restrict manually…"}
              </DropdownMenuItem>
            )}
            {groups.length > 0 && (
              // The group cause is cleared on Directory, never here.
              <DropdownMenuItem disabled className="flex-col items-start gap-0">
                <span>
                  Restricted {restrictionReason({ manual: false, groups })}
                </span>
                <small className={muted}>
                  Lift it in Directory, Restricted groups
                </small>
              </DropdownMenuItem>
            )}
            {(canRestrict || groups.length > 0) && <DropdownMenuSeparator />}
            {canResetGoogle && (
              <DropdownMenuItem onSelect={() => setResetting(true)}>
                Reset Google link…
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => setConfirm(true)}>
              Remove…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {denied && (
        <p
          role="status"
          className="col-span-full m-0 text-[length:var(--oa-text-sm)] text-[var(--oa-warning)]"
        >
          {denied}
        </p>
      )}
      {moving && <TransferDialog member={m} onClose={() => setMoving(false)} />}
      <ConfirmDialog
        open={resetting}
        onClose={() => setResetting(false)}
        title={`Reset Google link for ${label}?`}
        body={
          <p>
            {label} stays a member with the same roles but is signed out
            everywhere. Their next Google sign-in links their account again. Use
            this if they changed Google accounts or the link points to the wrong
            one.
          </p>
        }
        confirm="Reset link"
        onConfirm={() => {
          clearDenied(m.id);
          resetGoogle.mutate(m.id, {
            onSuccess: () =>
              toast({
                title: `Google link reset for ${label}. They're signed out and link again at their next Google sign-in.`,
                tone: "success",
              }),
            onError: (e) => {
              const code = e instanceof ApiClientError ? e.code : "";
              const status = e instanceof ApiClientError ? e.status : 0;
              if (status === 404)
                toast({
                  title: `No Google sign-in is linked to ${label}, so there's nothing to reset.`,
                  tone: "danger",
                });
              else if (code === "owner_only") denyMember(m.id, RESET_ONLY);
              else if (status === 403)
                toast({ title: RESET_ONLY, tone: "danger" });
            },
          });
        }}
      />
      <ConfirmDialog
        open={restricting}
        onClose={() => setRestricting(false)}
        title={`Restrict ${label}?`}
        body={
          <p>
            {spaces
              ? `${first} will only be able to view, in every space and in their personal space.`
              : `${first} will only be able to view.`}{" "}
            They can't publish, edit, share or write live data, from the app or
            any AI agent. Their artifacts stay where they are.
          </p>
        }
        confirm="Restrict"
        onConfirm={() =>
          setRestricted.mutate({ memberId: m.id, restricted: true })
        }
      />
      <ConfirmDialog
        open={lifting}
        onClose={() => setLifting(false)}
        title={`Lift ${first}'s manual restriction?`}
        body={
          <p>
            {groups.length
              ? `${first} stays restricted ${restrictionReason({ manual: false, groups })}. To lift that, remove ${groups.map((g) => g.name ?? g.email).join(", ")} from Restricted groups in Directory.`
              : spaces
                ? `${first} gets back the roles their spaces and groups give them.`
                : `${first} gets back what their role allows.`}
          </p>
        }
        confirm="Lift manual restriction"
        onConfirm={() =>
          setRestricted.mutate({ memberId: m.id, restricted: false })
        }
      />
      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Remove ${label}?`}
        description={
          // Parity 1, every install: artifacts stay, and shares stay on the removed
          // row, which refuses every sign-in, so they stay removed.
          "They lose access, including to anything shared with them. Their artifacts stay where they are. You can transfer them later under Departed, or restore this person."
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setConfirm(false);
                clearDenied(m.id);
                remove.mutate(m.id);
              }}
            >
              Remove member
            </Button>
          </>
        }
      />
    </li>
  );
}

export function Members() {
  useDocumentTitle("Members");
  const state = useMe();
  const q = useMembers();
  const [inviting, setInviting] = useState(false);
  const me = state.status === "authed" ? state.me.user : null;
  // A capped owner (restricted) acts like an admin here, as the server does.
  const owner =
    state.status === "authed" &&
    state.me.user.role === "owner" &&
    state.me.auth?.cap == null;
  // The plan locked the instance: this page still lists, nothing here writes.
  const frozen = useFrozen();
  // Spaces only change copy here: restriction and the More menu are on every install (parity 1).
  const spaces = state.status === "authed" && hasFeature(state.me, "spaces");
  const departed = useDeparted(state.status === "authed" ? state.me : null);
  // Every removed person, artifacts or not, each with Restore (parity 1).
  const admin = seesDeparted(state.status === "authed" ? state.me : null);
  const removedQ = useMembers("removed", admin);
  const removed = (removedQ.data ?? []).filter((m) => m.status === "removed");
  const [showRemoved, setShowRemoved] = useState(false);
  // A Retry that worked took its button away: on to the card, or Members if
  // nobody's left. Failed, focus stays on Retry; moved elsewhere, it stays there.
  const retrying = useRef(false);
  const nobodyLeft = departed.people.length === 0;
  useEffect(() => {
    const done = retrying.current && !departed.retrying;
    retrying.current = departed.retrying;
    if (!done || departed.failed || document.activeElement !== document.body)
      return;
    document
      .getElementById(nobodyLeft ? "oa-members-h" : "oa-departed-h")
      ?.focus();
  }, [departed.retrying, departed.failed, nobodyLeft]);
  return (
    <div className={STACK}>
      <ReadOnlyNote />
      {(departed.people.length > 0 || departed.failed) && (
        <DepartedCard
          people={departed.people}
          failed={departed.failed}
          error={departed.error}
          onRetry={departed.retry}
          retrying={departed.retrying}
          meId={me?.id ?? null}
          spaces={spaces}
          capped={
            state.status === "authed" &&
            state.me.auth?.cap != null &&
            state.me.auth.cap !== "plan"
          }
        />
      )}
      <SettingsCard
        id="oa-members-h"
        title="Members"
        focusable
        action={
          <div className="flex flex-wrap items-center gap-[var(--oa-space-2)]">
            {admin && (showRemoved || removed.length > 0) && (
              <Button
                size="sm"
                variant={showRemoved ? "secondary" : "ghost"}
                aria-pressed={showRemoved}
                className="text-[length:var(--oa-text-sm)]"
                onClick={() => setShowRemoved((v) => !v)}
              >
                Removed ({removed.length})
              </Button>
            )}
            <Button
              size="sm"
              className="text-[length:var(--oa-text-sm)]"
              disabled={frozen}
              onClick={() => setInviting(true)}
            >
              Add member
            </Button>
          </div>
        }
      >
        {showRemoved ? (
          removedQ.isError ? (
            <p role="alert" className={errorText}>
              Couldn't load removed people.
            </p>
          ) : removed.length === 0 ? (
            <p className={`m-0 ${muted}`}>Nobody is removed.</p>
          ) : (
            <ul className="grid p-0" aria-label="Removed people">
              {removed.map((m) => (
                <RemovedRow key={m.id} m={m} owner={owner} />
              ))}
            </ul>
          )
        ) : (
          <>
            {/* Design: why some rows are read-only, for anyone but the owner. */}
            {!owner &&
              q.data?.some(
                (m) =>
                  m.id !== me?.id && (m.role === "admin" || m.role === "owner"),
              ) && <p className={`m-0 ${muted}`}>{ADMIN_ONLY}</p>}
            {q.isError ? (
              <p role="alert" className={errorText}>
                Couldn't load members.
              </p>
            ) : (
              <ul className="grid p-0">
                {q.data?.map((m) => (
                  <Row
                    key={m.id}
                    m={m}
                    you={m.id === me?.id}
                    spaces={spaces}
                    owner={owner}
                    frozen={frozen}
                  />
                ))}
              </ul>
            )}
          </>
        )}
        {inviting && <InviteDialog onClose={() => setInviting(false)} />}
      </SettingsCard>
    </div>
  );
}

const STATUS = { suspended: "Suspended", removed: "Removed" } as const;

const RESTORE_ONLY = "Only the owner can restore an admin.";
/** A deleted Workspace account: the row's muted line and restore's 409 conflict. */
const ADDRESS_RELEASED =
  "This person's Google Workspace account was deleted, so they can't be restored. Invite them instead.";

/** One removed person under the Removed filter: Restore, refusals inline. */
function RemovedRow({
  m,
  owner,
}: {
  m: Member;
  /** The viewer is the owner, uncapped: only they restore an admin. */
  owner: boolean;
}) {
  const refusal = isReleased(m)
    ? ADDRESS_RELEASED
    : ownerOnlySource(m, owner)
      ? RESTORE_ONLY
      : null;
  const [restoring, setRestoring] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const label = personName(m);
  return (
    <li className="flex flex-wrap items-center gap-[10px] border-0 border-t border-border py-[var(--oa-space-2)] first:border-t-0">
      <UserAvatar name={m.name} email={m.email} />
      <div className="min-w-0 flex-1">
        <b className="flex min-w-0 flex-wrap items-center gap-x-[6px] font-medium">
          <span className="min-w-0 break-words">{label}</span>
          <Badge variant="outline" className="flex-none">
            Removed
          </Badge>
        </b>
        {secondLine(m) && (
          <small className={`block ${muted}`}>{secondLine(m)}</small>
        )}
      </div>
      {!refusal && (
        <Button
          size="sm"
          variant="outline"
          className="text-[length:var(--oa-text-sm)]"
          aria-label={`Restore ${label}`}
          onClick={() => {
            setProblem(null);
            setRestoring(true);
          }}
        >
          Restore…
        </Button>
      )}
      {refusal && <p className={`m-0 basis-full ${muted}`}>{refusal}</p>}
      {problem && (
        <p role="alert" className={`m-0 basis-full ${errorText}`}>
          {problem}
        </p>
      )}
      {!refusal && (
        <RestoreDialog
          member={m}
          open={restoring}
          onClose={() => setRestoring(false)}
          onRefused={setProblem}
        />
      )}
    </li>
  );
}

/** Inline copy for a refused restore (parity 1). */
const restoreRefusal = (e: unknown, first: string) => {
  const code = e instanceof ApiClientError ? e.code : "";
  if (code === "directory_managed")
    return `Removed by your Google Workspace. They come back if their Workspace account is restored.`;
  if (code === "guest_lapsed")
    return `${first} was a guest whose shares ended. Share something with them to bring them back.`;
  if (code === "member_active") return `${first} is already active.`;
  if (code === "owner_only") return RESTORE_ONLY;
  if (code === "conflict") return ADDRESS_RELEASED;
  return errorCopy(e, `Couldn't restore ${first}. Try again.`);
};

/** Departed people who still have personal artifacts (counts only, never titles). */
function DepartedCard({
  people,
  failed,
  error,
  onRetry,
  retrying,
  meId,
  spaces,
  capped,
}: {
  people: Departed[];
  /** The list or someone's counts never loaded: `people` may be short. */
  failed: boolean;
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
  /** Who "Transfer all to me" moves them to. */
  meId: string | null;
  spaces: boolean;
  /**
   * A restricted (capped) caller can't receive artifacts: no "to me". The
   * plan cap isn't one (a billing state): its Transfer shows, locked.
   */
  capped: boolean;
}) {
  return (
    <SettingsCard id="oa-departed-h" title="Departed" focusable>
      {people.length > 0 && (
        <>
          <p className={muted}>
            {people.length === 1
              ? `1 person left with ${spaces ? "personal " : ""}artifacts to transfer.`
              : `${people.length} people left with ${spaces ? "personal " : ""}artifacts to transfer.`}
          </p>
          <ul className="grid p-0">
            {people.map((d) => (
              <DepartedRow
                key={d.member.id}
                d={d}
                toMe={capped ? null : meId}
                spaces={spaces}
              />
            ))}
          </ul>
        </>
      )}
      {failed && (
        <LoadError
          title={
            people.length > 0
              ? "Some departed people didn't load."
              : "Couldn't load departed people."
          }
          error={error}
          onRetry={onRetry}
          busy={retrying}
        />
      )}
    </SettingsCard>
  );
}

/** Who, count, actions; at <= 600px (as Members): who, the count full width, then the actions. */
const DEPARTED_ROW =
  "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-[10px] gap-y-[2px] border-0 border-t border-border py-[var(--oa-space-2)] first:border-t-0 max-[600px]:gap-y-[var(--oa-space-1)]";

function DepartedRow({
  d: { member: m, summary },
  toMe,
  spaces,
}: {
  d: Departed;
  toMe: string | null;
  spaces: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [moving, setMoving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The plan locked the instance: transfers are refused (a team route), so
  // both entry points are off. Restore stays.
  const frozen = useFrozen();
  const run = useRunTransfer(m.id);
  const label = personName(m);
  const first = personFirst(m);
  const n = summary.live;
  const transferAllToMe = async () => {
    if (!toMe) return;
    setProblem(null);
    setMoving(true);
    try {
      const moved = await runAll(
        (i) => run.mutateAsync(i),
        { kind: "user", userId: toMe },
        () => {},
      );
      // 200 with nothing moved: another admin got there first, not a success.
      toast(
        moved === 0
          ? { title: ALREADY_HANDLED, tone: "info" }
          : {
              title: `Moved ${movedCount(moved, summary.live, summary.deleted)} from ${personInSentence(m)} to you.`,
              tone: "success",
            },
      );
    } catch (e) {
      setProblem(
        errorCopy(e, `Couldn't move ${first}'s artifacts. Try again.`),
      );
    } finally {
      setMoving(false);
    }
  };
  return (
    <li className={DEPARTED_ROW}>
      <div className="col-start-1 row-span-2 row-start-1 max-[600px]:row-span-1">
        <UserAvatar name={m.name} email={m.email} />
      </div>
      <b className="col-start-2 row-start-1 flex min-w-0 flex-wrap items-center gap-x-[6px] gap-y-[2px] self-end font-medium max-[600px]:self-center">
        <span className="min-w-0 break-words">{label}</span>
        <Badge variant="outline" className="flex-none">
          {STATUS[m.status]}
        </Badge>
      </b>
      <small
        className={`col-start-2 row-start-2 block self-start ${muted} max-[600px]:col-span-full max-[600px]:col-start-1`}
      >
        {n} {spaces && "personal "}
        {n === 1 ? "artifact" : "artifacts"}
        {summary.deleted > 0 && ` (plus ${summary.deleted} in trash)`}
        {spaces && " · their space artifacts stay put"}
      </small>
      <div
        data-testid="departed-actions"
        className="col-start-3 row-span-2 row-start-1 flex items-center justify-end gap-[10px] max-[600px]:col-span-full max-[600px]:col-start-1 max-[600px]:row-span-1 max-[600px]:row-start-3 max-[600px]:justify-between"
      >
        {toMe ? (
          <Button
            size="sm"
            variant="outline"
            className="text-[length:var(--oa-text-sm)]"
            disabled={moving || frozen}
            onClick={() => void transferAllToMe()}
          >
            {moving ? "Moving…" : "Transfer all to me"}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="text-[length:var(--oa-text-sm)]"
            aria-label={`Transfer ${label}'s artifacts`}
            disabled={frozen}
            onClick={() => setOpen(true)}
          >
            Transfer
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" aria-label={`More for ${label}`}>
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                width="16"
                height="16"
                fill="currentColor"
              >
                <circle cx="3" cy="8" r="1.5" />
                <circle cx="8" cy="8" r="1.5" />
                <circle cx="13" cy="8" r="1.5" />
              </svg>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="text-[length:var(--oa-text-sm)]"
          >
            <DropdownMenuItem
              disabled={moving || frozen}
              onSelect={() => setOpen(true)}
            >
              Transfer to someone else…
            </DropdownMenuItem>
            {m.status === "removed" && !isReleased(m) && (
              <DropdownMenuItem
                disabled={moving}
                onSelect={() => setRestoring(true)}
              >
                Restore…
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {problem && (
        <p role="alert" className={`col-span-full m-0 ${errorText}`}>
          {problem}
        </p>
      )}
      {open && <TransferDialog member={m} onClose={() => setOpen(false)} />}
      <RestoreDialog
        member={m}
        open={restoring}
        onClose={() => setRestoring(false)}
        onRefused={setProblem}
      />
    </li>
  );
}

/** Restore a removed member (parity 1): back as a plain member, restriction kept. */
function RestoreDialog({
  member: m,
  open,
  onClose,
  onRefused,
}: {
  member: Member;
  open: boolean;
  onClose: () => void;
  onRefused: (why: string) => void;
}) {
  const restore = useRestoreMember();
  const state = useMe();
  const spaces = state.status === "authed" && hasFeature(state.me, "spaces");
  const label = personName(m);
  const first = personFirst(m);
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title={`Restore ${label}?`}
      body={
        <p>
          {/* Manager's ruling: a guest stays a guest; anyone else comes back a member. */}
          {first} comes back{" "}
          {m.role === "guest" ? "as a guest" : "as a member (no admin role)"},
          with any manual restriction kept, and gets back the{" "}
          {spaces && "personal "}artifacts you haven't transferred. Their old
          tokens and agent connections stay off, so they sign in again.
        </p>
      }
      confirm="Restore"
      onConfirm={() =>
        restore.mutate(m.id, {
          onSuccess: () =>
            toast({
              title: `${label} is restored. They can sign in again.`,
              tone: "success",
            }),
          onError: (e) => onRefused(restoreRefusal(e, first)),
        })
      }
    />
  );
}
