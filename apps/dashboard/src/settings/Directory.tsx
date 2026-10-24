// `/settings/directory` (hosted P4 Tasks 17 and 18), Design D12 B: status
// first. The header names the sync state in a word, says what it means for
// access and offers the one fix; below it, held sweeps, restricted groups,
// then the connection with Disconnect last. Copy: build spec t6cjQuskQ6zrZaJd
// v5. Losing sync never cuts access, so `staleAt` is never shown.
import { R } from "@oa/shared";
import { displayName } from "@oa/ui";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
} from "@oa/ui/shadcn";
import { useMutationState, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ApiClientError } from "../api/client";
import {
  DirectoryConnectErrorSchema,
  type HeldSweep,
  type RestrictedGroup,
  type SyncStatus,
} from "../api/contract";
import { errorCopy } from "../api/errorCopy";
import {
  qk,
  useConfirmHeld,
  useDeleteRestrictedGroup,
  useDirectory,
  useDirectorySync,
  useDisconnectDirectory,
  useMembers,
  usePutRestrictedGroup,
  useRestrictedGroups,
} from "../api/queries";
import { useMe } from "../auth/useMe";
import { Notice } from "../layout/Notice";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { relativeTime } from "../library/time";
import { GroupPicker } from "./GroupPicker";
import { errorText, muted, SettingsCard, STACK } from "./ui";

const PAGE = "/settings/directory";
const REAUTH = `/auth/login/google?next=${encodeURIComponent(PAGE)}`;
/** After Sync now: poll R.directory until the status moves, for up to 2 minutes. */
const SYNC_POLL_MS = 5_000;
const SYNC_WINDOW_MS = 120_000;

const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

// -- times: relative on screen, exact on hover and for screen readers

const exactFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const timeFmt = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
});
const dayTimeFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const dayFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
/** "2:04 PM" today, else "Oct 20, 3:12 PM". */
const when = (iso: string) => {
  const d = new Date(iso);
  return sameDay(d, new Date()) ? timeFmt.format(d) : dayTimeFmt.format(d);
};
/** "3 h", "25 min", "2 days". */
const span = (iso: string) => {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
};

/** A time as the page shows it (`text`), with the exact time on hover and for screen readers. */
function When({ iso, text }: { iso: string; text: string }) {
  const exact = exactFmt.format(new Date(iso));
  return (
    <time dateTime={iso} title={exact}>
      <span aria-hidden="true">{text}</span>
      <span className="sr-only">{exact}</span>
    </time>
  );
}
const Rel = ({ iso }: { iso: string }) => (
  <When iso={iso} text={relativeTime(iso)} />
);
const At = ({ iso }: { iso: string }) => <When iso={iso} text={when(iso)} />;

// -- connect errors (`?error=` after Google)

/** The reason Google gave, or null when there is none to show. */
const connectCopy = (raw: string, domain: string | null): string | null => {
  const parsed = DirectoryConnectErrorSchema.safeParse(raw);
  switch (parsed.success ? parsed.data : "failed") {
    case "not_super_admin":
      return "Connect with a Google super admin account. Other accounts can't see every group.";
    case "domain_mismatch":
      return domain
        ? `That Google Workspace isn't ${domain}. Sign in with a ${domain} super admin.`
        : "That Google Workspace isn't your organization's. Sign in with your organization's super admin.";
    case "customer_mismatch":
      return "That Google Workspace belongs to a different organization. Reconnect the one you connected before.";
    case "scopes":
      return "Allow every requested permission, then try again. It's read-only: we never change anything in Google.";
    case "denied":
      return "Google access was declined. Nothing was connected.";
    case "expired":
      return "The connection took too long. Try again.";
    default:
      return null;
  }
};

// -- the status header

type Tone = "neutral" | "info" | "success" | "warning" | "danger";
const TONE: Record<Tone, string> = {
  neutral: "var(--oa-border-strong, var(--color-border))",
  info: "var(--oa-accent)",
  success: "var(--oa-success)",
  warning: "var(--oa-warning)",
  danger: "var(--oa-danger)",
};

/** The connect link: a full-page navigation to Google consent. */
function ConnectLink({ label }: { label: string }) {
  const [opening, setOpening] = useState(false);
  // Back from Google's consent page restores this page from the bfcache: reset.
  useEffect(() => {
    const reset = () => setOpening(false);
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);
  return (
    <Button asChild size="sm" className="text-[length:var(--oa-text-sm)]">
      <a href={R.directoryConnect} onClick={() => setOpening(true)}>
        {opening ? "Opening Google…" : label}
      </a>
    </Button>
  );
}

function Header({
  tone,
  label,
  action,
  children,
}: {
  tone: Tone;
  label: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section
      role="status"
      aria-label="Sync status"
      className="min-w-0 rounded-lg border border-border bg-card p-[var(--oa-space-5)] max-[600px]:p-[var(--oa-space-4)]"
      style={{ borderLeft: `4px solid ${TONE[tone]}` }}
    >
      <div className="flex flex-wrap items-start justify-between gap-[var(--oa-space-3)]">
        <h2 className="text-[length:var(--oa-text-lg)] font-semibold">
          {label}
        </h2>
        {action}
      </div>
      <div className="mt-[var(--oa-space-2)] grid gap-[var(--oa-space-2)] text-[length:var(--oa-text-sm)]">
        {children}
      </div>
    </section>
  );
}

function StatusHeader({
  sync,
  owner,
  ownerName,
  tokensUnverified,
  syncing,
  onSync,
  refusal,
}: {
  sync: SyncStatus;
  owner: boolean;
  ownerName: string | null;
  tokensUnverified: boolean;
  syncing: boolean;
  onSync: () => void;
  refusal: string | null;
}) {
  const domain = sync.binding?.domain ?? "";
  const only = (what: string) => (
    <p className={muted}>
      Only the owner{ownerName ? `, ${ownerName},` : ""} can {what}.
    </p>
  );
  const syncNow = owner && (
    <Button
      size="sm"
      variant="outline"
      className="text-[length:var(--oa-text-sm)]"
      disabled={syncing}
      onClick={onSync}
    >
      Sync now
    </Button>
  );
  const reconnect = owner && <ConnectLink label="Reconnect" />;
  const frozenUntilReconnect = sync.lastSuccessAt && (
    <p>
      Access is frozen as of the last sync (<At iso={sync.lastSuccessAt} />
      ). Changes in Google, including people who left, won't apply here until
      you reconnect.
    </p>
  );
  const refused = refusal && (
    <p role="alert" className={errorText}>
      {refusal}
    </p>
  );
  const adminNote =
    !owner && only("run a sync, apply held changes or disconnect");

  if (sync.mode === "off")
    return (
      <Header
        tone="neutral"
        label="Not connected"
        action={owner && <ConnectLink label="Connect Google Workspace" />}
      >
        <p>
          Connect your Google Workspace so space access follows your Google
          groups.
        </p>
        <p className={muted}>
          Read-only access to your users, groups, domains and admin activity
          log. We never change anything in Google.
        </p>
        <p className={muted}>
          The connecting account must be a Google super admin.
        </p>
        {!owner && only("connect Google Workspace")}
      </Header>
    );

  if (sync.mode === "frozen")
    return (
      <Header tone="neutral" label="Frozen">
        <p>
          {sync.lastSuccessAt ? (
            <>
              Space memberships were kept as of <At iso={sync.lastSuccessAt} />{" "}
              and are managed manually.
            </>
          ) : (
            "Space memberships are managed manually."
          )}
        </p>
      </Header>
    );

  if (syncing)
    return (
      <Header tone="success" label="Syncing…" action={syncNow}>
        <p className={muted}>{domain} · started just now</p>
      </Header>
    );

  switch (sync.state) {
    case "ok":
      return (
        <Header tone="success" label="Healthy" action={syncNow}>
          <p className={muted}>
            {domain}
            {sync.lastSuccessAt && (
              <>
                {" "}
                · last synced <Rel iso={sync.lastSuccessAt} />
              </>
            )}
            {sync.nextRunAt && (
              <>
                {" "}
                · next sync <Rel iso={sync.nextRunAt} />
              </>
            )}
          </p>
          {refused}
          {adminNote}
        </Header>
      );
    case "never":
      return (
        <Header tone="info" label="Not synced yet">
          <p className={muted}>
            {domain}
            {sync.binding && (
              <>
                {" "}
                · first sync started <Rel iso={sync.binding.connectedAt} />
              </>
            )}
          </p>
          {adminNote}
        </Header>
      );
    case "backoff":
      return (
        <Header tone="warning" label="Retrying" action={syncNow}>
          {sync.unhealthySince && (
            <p>
              Failing since <At iso={sync.unhealthySince} /> (
              {span(sync.unhealthySince)}).
              {sync.nextRunAt && (
                <>
                  {" "}
                  Next try <At iso={sync.nextRunAt} />.
                </>
              )}
            </p>
          )}
          {sync.lastSuccessAt && (
            <p>
              Access is frozen as of the last sync (
              <At iso={sync.lastSuccessAt} />
              ). Changes in Google, including people who left, won't apply here
              until sync recovers.
            </p>
          )}
          <p className={muted}>
            Nobody loses access while sync is down. While sync is down, people
            sign in again every 24 hours.
          </p>
          {tokensUnverified && (
            <p className={muted}>
              Agent tokens aren't being re-checked. If someone left, remove them
              in Members.
            </p>
          )}
          {sync.lastError && (
            <p className={muted}>Last error: {sync.lastError.message}.</p>
          )}
          {refused}
          {adminNote}
        </Header>
      );
    case "auth_failed":
      return (
        <Header tone="danger" label="Google access lost" action={reconnect}>
          <p>
            Our connection to Google was revoked or expired
            {sync.unhealthySince ? (
              <>
                {" "}
                on <At iso={sync.unhealthySince} />
              </>
            ) : null}
            .
          </p>
          {owner && <p>Reconnect with a Google super admin account.</p>}
          {frozenUntilReconnect}
          {!owner && only("reconnect")}
        </Header>
      );
    case "scope_missing":
      return (
        <Header tone="danger" label="Permission removed" action={reconnect}>
          <p>
            A permission we need was removed in Google
            {sync.unhealthySince ? (
              <>
                {" "}
                on <At iso={sync.unhealthySince} />
              </>
            ) : null}
            .
          </p>
          {owner && (
            <p>Reconnect and allow every permission Google asks for.</p>
          )}
          {frozenUntilReconnect}
          {!owner && only("reconnect")}
        </Header>
      );
    case "customer_mismatch":
      return (
        <Header tone="danger" label="Wrong Google Workspace" action={reconnect}>
          <p>
            Sync stopped: the connection now points to a different organization.
          </p>
          {owner ? (
            <p>
              {sync.customerMismatch
                ? `Connected: customer ${sync.customerMismatch.expected}. Now: ${sync.customerMismatch.actual}. `
                : ""}
              Nothing was changed. Reconnect with the {domain} Google Workspace,
              as a super admin.
            </p>
          ) : (
            <p>Nothing was changed.</p>
          )}
          {frozenUntilReconnect}
          {!owner && only("reconnect")}
        </Header>
      );
  }
}

// -- confirm dialogs

function Confirm({
  open,
  onClose,
  title,
  body,
  confirm,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  body: ReactNode;
  confirm: string;
  onConfirm: () => void;
}) {
  const opener = useRef<HTMLElement | null>(null);
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent
        className="gap-[var(--oa-space-4)] sm:max-w-[440px]"
        // Controlled, with no Radix Trigger: put focus back on whatever opened it.
        onOpenAutoFocus={() => {
          opener.current = document.activeElement as HTMLElement | null;
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          opener.current?.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="text-[length:var(--oa-text-lg)]">
            {title}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="grid gap-[var(--oa-space-2)] text-[length:var(--oa-text-sm)] text-foreground">
              {body}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            onClick={() => {
              onClose();
              onConfirm();
            }}
          >
            {confirm}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// -- held sweeps (Task 18)

function HeldRow({
  h,
  owner,
  restricted,
}: {
  h: HeldSweep;
  owner: boolean;
  restricted: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const confirm = useConfirmHeld();
  const empty = h.wouldRemove >= h.members;
  return (
    <li className="flex flex-wrap items-center justify-between gap-[var(--oa-space-3)] border-0 border-t border-border py-[var(--oa-space-3)] first:border-t-0">
      <div className="min-w-0">
        <b className="block font-medium">
          {h.name} ({h.email})
        </b>
        <small className={`block ${muted}`}>
          {h.wouldRemove} of {h.members} members would lose access ·{" "}
          {empty
            ? "Google lists the group as empty"
            : "more than half the group"}{" "}
          · since <At iso={h.since} />
        </small>
      </div>
      {owner && (
        <Button
          size="sm"
          variant="outline"
          className="text-[length:var(--oa-text-sm)]"
          onClick={() => setAsking(true)}
        >
          Apply
        </Button>
      )}
      <Confirm
        open={asking}
        onClose={() => setAsking(false)}
        title={`Remove ${people(h.wouldRemove)} from ${h.name}?`}
        body={
          <>
            <p>
              {empty
                ? `Google lists ${h.email} as empty.`
                : `Google no longer lists ${h.wouldRemove} of the ${h.members} people in ${h.email}.`}{" "}
              {restricted
                ? `Applying this lifts the restriction for ${people(h.wouldRemove)}.`
                : `Applying this takes away what ${h.name} gives them in spaces, within a minute. Their artifacts stay where they are.`}
            </p>
            <p>
              If this looks wrong, fix the group in Google Admin and leave it
              waiting.
            </p>
          </>
        }
        confirm={`Remove ${people(h.wouldRemove)}`}
        onConfirm={() => confirm.mutate(h.groupId)}
      />
    </li>
  );
}

function HeldSweeps({
  held,
  owner,
  restricted,
}: {
  held: HeldSweep[];
  owner: boolean;
  restricted: RestrictedGroup[];
}) {
  return (
    <SettingsCard id="oa-dir-held" title="Waiting for your confirmation">
      <p className={muted}>
        These changes from Google would remove a lot of people at once, so we
        held them. Nobody loses access until you apply one.
      </p>
      <ul>
        {held.map((h) => (
          <HeldRow
            key={h.groupId}
            h={h}
            owner={owner}
            restricted={restricted.some((g) => g.groupId === h.groupId)}
          />
        ))}
      </ul>
    </SettingsCard>
  );
}

// -- restricted groups (Task 18)

function RestrictedRow({ g }: { g: RestrictedGroup }) {
  const [asking, setAsking] = useState(false);
  const lift = useDeleteRestrictedGroup();
  return (
    <tr className="border-0 border-t border-border first:border-t-0">
      <td className="min-w-0 py-[var(--oa-space-3)]">
        <b className="block font-medium">{g.name}</b>
        <small className={`block ${muted}`}>
          {g.email}
          {g.memberCount !== null && ` · ${people(g.memberCount)}`}
        </small>
      </td>
      <td className="py-[var(--oa-space-3)] text-right">
        <Button
          size="sm"
          variant="outline"
          className="text-[length:var(--oa-text-sm)]"
          aria-label={`Lift restriction on ${g.name ?? g.email}`}
          onClick={() => setAsking(true)}
        >
          Lift
        </Button>
        <Confirm
          open={asking}
          onClose={() => setAsking(false)}
          title={`Lift the ${g.name} restriction?`}
          body={
            <p>
              {g.memberCount === null
                ? "Its members get"
                : `${people(g.memberCount)} ${g.memberCount === 1 ? "gets" : "get"}`}{" "}
              back the roles their spaces and groups give them. Anyone
              restricted manually stays restricted.
            </p>
          }
          confirm="Lift restriction"
          onConfirm={() => lift.mutate(g.groupId)}
        />
      </td>
    </tr>
  );
}

function RestrictedGroups({
  groups,
  mode,
}: {
  groups: RestrictedGroup[];
  mode: SyncStatus["mode"];
}) {
  const add = usePutRestrictedGroup();
  const refusal =
    add.error instanceof ApiClientError &&
    add.error.code === "directory_sync_off"
      ? errorCopy(add.error, "", { onDirectoryPage: true })
      : null;
  return (
    <SettingsCard id="oa-dir-restricted" title="Restricted groups">
      <p className={muted}>
        People in these groups can only view, everywhere: no publishing, editing
        or live-data writes.
      </p>
      {groups.length > 0 && (
        <table className="w-full border-collapse">
          <tbody>
            {groups.map((g) => (
              <RestrictedRow key={g.groupId} g={g} />
            ))}
          </tbody>
        </table>
      )}
      {mode === "google" && (
        <GroupPicker
          label="Add a restricted group"
          placeholder="Add a restricted group…"
          exclude={groups.map((g) => g.groupId)}
          disabled={add.isPending}
          onPick={(g) => add.mutate(g.groupId)}
        />
      )}
      {mode === "frozen" && (
        <p className={muted}>
          Adding restricted groups needs group sync (Business). To restrict one
          person, use Members.
        </p>
      )}
      {refusal && (
        <p role="alert" className={errorText}>
          {refusal}
        </p>
      )}
    </SettingsCard>
  );
}

// -- connection

function Connection({ sync, owner }: { sync: SyncStatus; owner: boolean }) {
  const [asking, setAsking] = useState(false);
  const disconnect = useDisconnectDirectory();
  const b = sync.binding;
  if (!b) return null;
  return (
    <SettingsCard id="oa-dir-connection" title="Connection">
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-[var(--oa-space-4)] gap-y-[var(--oa-space-2)] text-[length:var(--oa-text-sm)]">
        <dt className="text-muted-foreground">Workspace</dt>
        <dd className="min-w-0 truncate">{b.domain}</dd>
        <dt className="text-muted-foreground">Connected by</dt>
        <dd className="min-w-0 truncate">
          {b.connectedBy} on{" "}
          <When
            iso={b.connectedAt}
            text={dayFmt.format(new Date(b.connectedAt))}
          />
        </dd>
      </dl>
      {owner && sync.mode === "google" && (
        <div>
          <Button
            size="sm"
            variant="outline"
            className="text-[length:var(--oa-text-sm)] text-destructive"
            onClick={() => setAsking(true)}
          >
            Disconnect
          </Button>
        </div>
      )}
      <Confirm
        open={asking}
        onClose={() => setAsking(false)}
        title="Disconnect Google Workspace?"
        body={
          <>
            <p>
              Sync stops. Space memberships stay as they are and are managed
              manually. Nobody loses access.
            </p>
            <p>
              People who leave in Google keep their access here until you remove
              them in Members. Restricted groups stay in force until you lift
              them.
            </p>
          </>
        }
        confirm="Disconnect"
        onConfirm={() => disconnect.mutate()}
      />
    </SettingsCard>
  );
}

// -- the page

function Reauth() {
  return (
    <SettingsCard id="oa-dir-reauth" title="Sign in again to continue">
      <p>
        For your security, sign in with Google again to manage the directory.
      </p>
      <div>
        <Button asChild size="sm" className="text-[length:var(--oa-text-sm)]">
          <a href={REAUTH}>Sign in with Google again</a>
        </Button>
      </div>
      <p className={muted}>
        You'll come straight back here. It's needed while sync is down.
      </p>
    </SettingsCard>
  );
}

const isReauth = (e: unknown) =>
  e instanceof ApiClientError && e.code === "reauth_required";

export function Directory() {
  useDocumentTitle("Directory");
  const state = useMe();
  const me = state.status === "authed" ? state.me : null;
  const owner = me?.user.role === "owner";
  const search = useSearch({ strict: false }) as {
    connected?: string;
    error?: string;
  };
  const navigate = useNavigate();
  const qc = useQueryClient();
  const status = useDirectory();
  const restricted = useRestrictedGroups();
  const members = useMembers();
  const sync = useDirectorySync();
  // Any directory call may answer reauth_required, including the rows' own mutations.
  const failed = useMutationState({
    filters: { status: "error" },
    select: (m) => m.state.error,
  });

  // Sync now answers 202 with no running state: poll until the status moves.
  const [syncing, setSyncing] = useState<{
    success: string | null;
    error: string | null;
    until: number;
  } | null>(null);
  const data = status.data;
  useEffect(() => {
    if (!syncing || !data) return;
    if (
      data.lastSuccessAt !== syncing.success ||
      (data.lastError?.at ?? null) !== syncing.error ||
      Date.now() > syncing.until
    ) {
      setSyncing(null);
      return;
    }
    const t = setInterval(() => {
      if (Date.now() > syncing.until) setSyncing(null);
      else void qc.invalidateQueries({ queryKey: qk.directory });
    }, SYNC_POLL_MS);
    return () => clearInterval(t);
  }, [syncing, data, qc]);

  const clearQuery = () =>
    void navigate({ to: PAGE as string, search: {}, replace: true });

  if ([status.error, restricted.error, ...failed].some(isReauth))
    return <Reauth />;

  const owners = members.data?.filter((m) => m.role === "owner") ?? [];
  const ownerName = owners[0] ? displayName(owners[0]) : null;
  const domain = data?.binding?.domain ?? null;
  const refusal =
    sync.error instanceof ApiClientError &&
    sync.error.code === "directory_sync_off"
      ? errorCopy(sync.error, "", { onDirectoryPage: true })
      : null;

  return (
    <div className={STACK}>
      {/* After the status loads: the copy names the bound domain. */}
      {search.error !== undefined && !status.isPending && (
        <Notice
          tone="danger"
          title="Couldn't connect Google Workspace."
          action={
            owner ? (
              <Button asChild size="sm" variant="outline">
                <a href={R.directoryConnect}>Try again</a>
              </Button>
            ) : undefined
          }
          onDismiss={clearQuery}
        >
          {connectCopy(String(search.error), domain)}
        </Notice>
      )}
      {search.connected === "1" && (
        <Notice
          tone="success"
          title="Google Workspace connected."
          onDismiss={clearQuery}
        >
          The first sync is running. It usually takes a few minutes.
        </Notice>
      )}
      {status.isError && !data && (
        <p role="alert" className={errorText}>
          Couldn't load the directory status. Try again.
        </p>
      )}
      {data && (
        <>
          <StatusHeader
            sync={data}
            owner={owner}
            ownerName={ownerName}
            tokensUnverified={me?.instance.directory?.tokensUnverified === true}
            syncing={syncing !== null}
            refusal={refusal}
            onSync={() =>
              sync.mutate(undefined, {
                onSuccess: () =>
                  setSyncing({
                    success: data.lastSuccessAt,
                    error: data.lastError?.at ?? null,
                    until: Date.now() + SYNC_WINDOW_MS,
                  }),
              })
            }
          />
          {data.held.length > 0 && (
            <HeldSweeps
              held={data.held}
              owner={owner}
              restricted={restricted.data ?? []}
            />
          )}
          {(data.mode !== "off" || (restricted.data?.length ?? 0) > 0) && (
            <RestrictedGroups groups={restricted.data ?? []} mode={data.mode} />
          )}
          <Connection sync={data} owner={owner} />
        </>
      )}
    </div>
  );
}
