import { type Member, MemberInviteSchema, type Role } from "@oa/shared";
import { displayName } from "@oa/ui";
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
import { useRef, useState } from "react";
import { ApiClientError } from "../api/client";
import { hasFeature, InviteUnreachableDetailsSchema } from "../api/contract";
import {
  useInviteMember,
  useMembers,
  usePatchMember,
  useRemoveMember,
  useResetIdentity,
  useSetRestricted,
} from "../api/queries";
import { emailEnabled } from "../auth/emailEnabled";
import {
  inviteRefusedCopy,
  inviteUncertainCopy,
  signInWith,
  useSignInDomains,
} from "../auth/reach";
import { useMe } from "../auth/useMe";
import { CopyLink } from "../layout/CopyLink";
import { Modal } from "../layout/Modal";
import { Notice } from "../layout/Notice";
import { toast } from "../layout/toast";
import { UserAvatar } from "../layout/UserAvatar";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { relativeTime } from "../library/time";
import { ConfirmDialog } from "./ConfirmDialog";
import { clearDenied, denyMember, useDenied } from "./denied";
import { type Departed, useDeparted } from "./departed";
import { restrictionReason } from "./restriction";
import { TransferDialog } from "./Transfer";
import { errorText, muted, SettingsCard, STACK } from "./ui";

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
  const invite = useInviteMember();
  const domains = useSignInDomains();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Assignable>("member");
  const [error, setError] = useState<string | null>(null);
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
          // Nothing was created: Design's copy, not the server's message.
          const refused =
            e instanceof ApiClientError && e.code === "invite_unreachable"
              ? InviteUnreachableDetailsSchema.safeParse(e.details)
              : null;
          setError(
            refused?.success
              ? inviteRefusedCopy(refused.data.reason, parsed, domains)
              : e instanceof ApiClientError
                ? e.message
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

/** "Bob" from "Bob Builder", else the email's local part. */
const firstName = (m: Member) =>
  m.name?.trim().split(/\s+/)[0] || m.email.split("@")[0];

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

function Row({
  m,
  you,
  hosted,
  owner,
  frozen,
}: {
  /** The plan locked the instance (cap "plan"): reads stay, every write control is off. */
  frozen: boolean;
  m: Member;
  you: boolean;
  hosted: boolean;
  /** The viewer is the owner, uncapped: only they act on owner and admin rows. */
  owner: boolean;
}) {
  const denyAdmin = (id: string) => denyMember(id, ADMIN_ONLY);
  const patch = usePatchMember(denyAdmin, denyMember);
  const [confirm, setConfirm] = useState(false);
  const [restricting, setRestricting] = useState(false);
  const [lifting, setLifting] = useState(false);
  const remove = useRemoveMember(denyAdmin);
  const denied = useDenied(m.id);
  const setRestricted = useSetRestricted();
  const resetGoogle = useResetIdentity();
  const [resetting, setResetting] = useState(false);
  const canResetGoogle = hosted && mayResetGoogle(m, you, owner);
  const label = displayName(m);
  // Another admin's (or the owner's) row, seen by anyone but the owner: read-only.
  const readOnly = !owner && (m.role === "admin" || m.role === "owner");
  const locked = m.role === "owner" || you || readOnly;
  const why = hosted ? restrictionReason(m.restriction) : null;
  const manual = m.restriction?.manual === true;
  const groups = m.restriction?.groups ?? [];
  // The manual flag only: active members, never owners, admins or guests.
  const canRestrict =
    hosted && m.role === "member" && (m.status ?? "active") === "active";
  const first = firstName(m);
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
          {(m.name || why) && (
            <small className={`block truncate ${muted}`}>
              {m.name ? m.email : null}
              {/* At <= 600px the badge and reason move to the control line. */}
              <span className="max-[600px]:hidden">
                {m.name && why ? " · " : null}
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
      ) : hosted ? (
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
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="justify-self-end text-[length:var(--oa-text-sm)]"
          aria-label={`Remove ${label}`}
          disabled={frozen}
          onClick={() => setConfirm(true)}
        >
          Remove
        </Button>
      )}
      {denied && (
        <p
          role="status"
          className="col-span-full m-0 text-[length:var(--oa-text-sm)] text-[var(--oa-warning)]"
        >
          {denied}
        </p>
      )}
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
            {first} will only be able to view, in every space and in their
            personal space. They can't publish, edit, share or write live data,
            from the app or any AI agent. Their artifacts stay where they are.
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
              : `${first} gets back the roles their spaces and groups give them.`}
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
          // Removing also unshares what was shared with them (#795), so they stay removed.
          hosted
            ? "They lose access, including to anything shared with them. Their artifacts stay where they are. You can transfer their personal artifacts later under Departed."
            : owner
              ? "They lose access, including to anything shared with them. Their artifacts move to you."
              : "They lose access, including to anything shared with them. Their artifacts move to the instance owner."
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
  const frozen = state.status === "authed" && state.me.auth?.cap === "plan";
  // Hosted (the spaces feature): restriction badges and the row's More menu.
  const hosted = state.status === "authed" && hasFeature(state.me, "spaces");
  const departed = useDeparted(state.status === "authed" ? state.me : null);
  return (
    <div className={STACK}>
      {departed.length > 0 && <DepartedCard people={departed} />}
      <SettingsCard
        id="oa-members-h"
        title="Members"
        action={
          <Button
            size="sm"
            className="text-[length:var(--oa-text-sm)]"
            disabled={frozen}
            onClick={() => setInviting(true)}
          >
            Add member
          </Button>
        }
      >
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
                hosted={hosted}
                owner={owner}
                frozen={frozen}
              />
            ))}
          </ul>
        )}
        {inviting && <InviteDialog onClose={() => setInviting(false)} />}
      </SettingsCard>
    </div>
  );
}

const STATUS = { suspended: "Suspended", removed: "Removed" } as const;

/** Departed people who still have personal artifacts (counts only, never titles). */
function DepartedCard({ people }: { people: Departed[] }) {
  return (
    <SettingsCard id="oa-departed-h" title="Departed">
      <p className={muted}>
        {people.length === 1
          ? "1 person left with personal artifacts to transfer."
          : `${people.length} people left with personal artifacts to transfer.`}
      </p>
      <ul className="grid p-0">
        {people.map((d) => (
          <DepartedRow key={d.member.id} d={d} />
        ))}
      </ul>
    </SettingsCard>
  );
}

function DepartedRow({ d: { member: m, summary } }: { d: Departed }) {
  const [open, setOpen] = useState(false);
  const label = displayName(m);
  const n = summary.live;
  return (
    <li className="flex flex-wrap items-center gap-[10px] border-0 border-t border-border py-[var(--oa-space-2)] first:border-t-0">
      <UserAvatar name={m.name} email={m.email} />
      <div className="min-w-0 flex-1">
        <b className="flex min-w-0 flex-wrap items-center gap-x-[6px] gap-y-[2px] font-medium">
          <span className="min-w-0 break-words">{label}</span>
          <Badge variant="outline" className="flex-none">
            {STATUS[m.status]}
          </Badge>
        </b>
        <small className={`block ${muted}`}>
          {n} personal {n === 1 ? "artifact" : "artifacts"}
          {summary.deleted > 0 && ` (plus ${summary.deleted} in trash)`} · their
          space artifacts stay put
        </small>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="text-[length:var(--oa-text-sm)]"
        aria-label={`Transfer ${label}'s artifacts`}
        onClick={() => setOpen(true)}
      >
        Transfer
      </Button>
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
          <DropdownMenuItem onSelect={() => setOpen(true)}>
            Transfer…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {open && <TransferDialog member={m} onClose={() => setOpen(false)} />}
    </li>
  );
}
