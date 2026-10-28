// A space's People (hosted P4 Task 12, Design D6 as recommended): the space's
// member rows from R.spaceMembers, people added manually and people synced
// through a mapped group. One reason line per person; a role select that only
// raises (PUT sets the manual row; the highest role wins); Remove only where a
// manual role exists; frozen sync lets kept rows be edited and removed. People
// reached only through All members aren't rows, so they aren't listed.
import type { SpaceMember, SpaceRole } from "@oa/shared";
import { displayName } from "@oa/ui";
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
} from "@oa/ui/shadcn";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { ApiClientError } from "../../api/client";
import type { Restriction, Space, SpaceCandidate } from "../../api/contract";
import {
  qk,
  useDeleteSpaceMember,
  usePutSpaceMember,
  useSpaceCandidates,
  useSpaceMappings,
  useSpaceMembers,
} from "../../api/queries";
import { useMe } from "../../auth/useMe";
import { LoadError } from "../../layout/LoadError";
import { Modal } from "../../layout/Modal";
import { UserAvatar } from "../../layout/UserAvatar";
import { AppLink } from "../../library/AppLink";
import { ConfirmDialog } from "../ConfirmDialog";
import { errorText, muted, SettingsCard } from "../ui";
import { ALL_ROLES, people, ROLE_LABEL, RoleSelect } from "./SpaceAccess";

const RANK: Record<SpaceRole, number> = { viewer: 0, editor: 1, manager: 2 };
const VERB: Record<SpaceRole, string> = {
  viewer: "view",
  editor: "edit",
  manager: "manage",
};
const SEARCH_FROM = 20;

/** "eng@" from eng@example.com. */
const short = (email: string) => `${email.split("@")[0]}@`;
const first = (m: SpaceMember) =>
  m.user.name?.trim().split(/\s+/)[0] || m.user.email?.split("@")[0] || "";
const nameOf = (m: SpaceMember) => displayName(m.user);

/**
 * The groups that grant the synced role, one per group: a group mapped here
 * and as Every space shows only its stronger entry (a tie keeps this space's).
 */
const grants = (m: SpaceMember) => {
  const best = new Map<string, SpaceMember["groups"][number]>();
  for (const g of m.groups) {
    const had = best.get(g.groupId);
    if (
      !had ||
      RANK[g.role] > RANK[had.role] ||
      (RANK[g.role] === RANK[had.role] && g.via === "space")
    )
      best.set(g.groupId, g);
  }
  return [...best.values()];
};
/** "via eng@, exec@ (every space)". */
const groupsText = (m: SpaceMember) => {
  const list = grants(m).map(
    (g) => `${short(g.email)}${g.via === "every" ? " (every space)" : ""}`,
  );
  return list.length ? `via ${list.join(", ")}` : "";
};
const syncShort = (m: SpaceMember) =>
  grants(m)
    .map((g) => short(g.email))
    .join(", ") || "a group";

/** Where access comes from, winning role first. */
const source = (m: SpaceMember, frozen: boolean) => {
  if (frozen && m.syncRole) return `kept from ${syncShort(m)}`;
  if (m.manualRole && m.syncRole) {
    const manual = `${ROLE_LABEL[m.manualRole]} (manually added)`;
    const sync = `${ROLE_LABEL[m.syncRole]} ${groupsText(m)}`;
    return m.source === "manual" ? `${manual}, ${sync}` : `${sync}, ${manual}`;
  }
  if (m.manualRole) return "manually added";
  return groupsText(m);
};

/** Another manager's row is an admin's to change. */
const MANAGER_ONLY = "Only an admin can change another manager's access.";

/** Every space groups (org mappings, review item 19): the highest role they give, or null. */
const everyRole = (m: SpaceMember): SpaceRole | null =>
  m.groups
    .filter((g) => g.via === "every")
    .reduce<SpaceRole | null>(
      (best, g) => (best === null || RANK[g.role] > RANK[best] ? g.role : best),
      null,
    );
/** Here only through an Every space group: no manual role, no group of this space's own. */
const everyOnly = (m: SpaceMember) =>
  !m.manualRole &&
  m.groups.length > 0 &&
  m.groups.every((g) => g.via === "every");
/** Where an Every space group is changed: org admins only (R.orgMappings). */
const EVERY_SPACE = "/settings/spaces#oa-every-space";
const SET_BY_EVERY = "Set by an Every space group.";
const everyLine = (admin: boolean) =>
  admin
    ? `${SET_BY_EVERY} Change it in Settings › Spaces › Every space.`
    : `${SET_BY_EVERY} Ask an admin to change it.`;

/** The per-row reason line under the email. */
const reason = (
  m: SpaceMember,
  frozen: boolean,
  restricted: Restriction | null | undefined,
) => {
  if (m.status !== "active") {
    const lead =
      m.status === "suspended" ? "No access while suspended" : "No access";
    const why =
      m.manualRole && !m.syncRole
        ? `${ROLE_LABEL[m.manualRole]} (manually added)`
        : source(m, frozen);
    return `${lead} · ${why}`;
  }
  if (m.cap === "restricted") {
    const via = restricted?.groups.length
      ? ` via ${restricted.groups.map((g) => g.name ?? g.email).join(", ")}`
      : "";
    return `Can only view · restricted${via}`;
  }
  if (m.cap === "guest") return `Guest · can only view · ${source(m, frozen)}`;
  return source(m, frozen);
};

/** Active by role then name, then suspended, then removed. */
const order = (a: SpaceMember, b: SpaceMember) => {
  const s = { active: 0, suspended: 1, removed: 2 } as const;
  return (
    s[a.status] - s[b.status] ||
    RANK[b.role] - RANK[a.role] ||
    nameOf(a).localeCompare(nameOf(b))
  );
};

/** What a refused member change says, by the row. `promote`: the change was a grant of Manager. */
const refusal = (
  e: unknown,
  m: SpaceMember,
  admin: boolean,
  promote = false,
) => {
  if (e instanceof ApiClientError) {
    // 409 managed_by_org_mapping (review item 19): removing or lowering what an
    // Every space group gives can't take effect.
    if ((e.code as string) === "managed_by_org_mapping")
      return everyLine(admin);
    if (e.code === "member_synced")
      return `${first(m)} is here through ${syncShort(m)}. Change it in Google, or remove the group under Who gets access.`;
    if (e.code === "space_forbidden")
      return promote
        ? "Only an admin can make someone a manager."
        : MANAGER_ONLY;
    if (e.code === "not_found")
      return "You no longer manage this space. Refresh to see it as it is now.";
  }
  return "Couldn't save. Try again.";
};

function PersonRow({
  m,
  space,
  admin,
  you,
  frozen,
  restricted,
}: {
  m: SpaceMember;
  space: Space;
  admin: boolean;
  you: boolean;
  frozen: boolean;
  restricted: Restriction | null | undefined;
}) {
  const qc = useQueryClient();
  const put = usePutSpaceMember(space.id);
  const del = useDeleteSpaceMember(space.id);
  // A 403 means the list is stale: refetch so the row goes read-only.
  const refused = (e: unknown, promote = false) => {
    setProblem(refusal(e, m, admin, promote));
    if (e instanceof ApiClientError && e.code === "space_forbidden")
      void qc.invalidateQueries({ queryKey: qk.spaceMembers(space.id) });
  };
  const [pending, setPending] = useState<SpaceRole | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const name = nameOf(m);
  // A space manager can't remove, demote or override another manager's row,
  // manual or synced, frozen kept rows included (the server answers 403
  // space_forbidden { target: "member" }): the role shows as text.
  const canAct = admin || m.role !== "manager";
  const active = m.status === "active";
  const capped = m.cap !== null;
  const allowed = admin ? ALL_ROLES : ALL_ROLES.filter((r) => r !== "manager");
  // PUT sets the manual row and the highest role wins: a synced role can only
  // be raised here (frozen kept rows take any role).
  // An Every space group's role is a floor everywhere, frozen included: the
  // server refuses anything below it (409 managed_by_org_mapping).
  const every = everyRole(m);
  const floor = Math.max(
    !frozen && m.syncRole ? RANK[m.syncRole] : 0,
    every ? RANK[every] : 0,
  );
  const options = allowed.filter((r) => RANK[r] >= floor);
  const shown = pending ?? m.role;
  const select =
    canAct && active && !capped && options.some((r) => r !== m.role);
  const label = (r: SpaceRole) =>
    !frozen && m.syncRole
      ? r === m.syncRole
        ? `${ROLE_LABEL[r]} · ${groupsText(m)}`
        : `${ROLE_LABEL[r]} · manually added`
      : ROLE_LABEL[r];

  const change = (r: SpaceRole) => {
    if (r === m.role) return;
    setProblem(null);
    setPending(r);
    put.mutate(
      { userId: m.userId, role: r },
      {
        onError: (e) => refused(e, r === "manager"),
        onSettled: () => setPending(null),
      },
    );
  };
  const remove = () => {
    setProblem(null);
    del.mutate(m.userId, { onError: (e) => refused(e) });
  };

  // The one removal this row offers, and its confirm.
  const kept = frozen && !!m.syncRole;
  const removal =
    !canAct || everyOnly(m)
      ? null
      : you && (m.manualRole || kept)
        ? {
            item: `Leave ${space.name}…`,
            title: `Leave ${space.name}?`,
            body: "You won't be able to manage this space after this. An admin can add you back.",
            button: "Leave",
          }
        : kept
          ? {
              item: `Remove from ${space.name}…`,
              title: `Remove ${name} from ${space.name}?`,
              body: `${first(m)} loses access to ${space.name} within a minute. If sync comes back and ${syncShort(m)} still includes ${first(m)}, ${first(m)} gets ${ROLE_LABEL[m.syncRole as SpaceRole]} again.`,
              button: "Remove",
            }
          : m.manualRole &&
              m.syncRole &&
              every &&
              everyOnly({ ...m, manualRole: null })
            ? {
                item: "Remove manually added role…",
                hint: `${first(m)} keeps ${ROLE_LABEL[every]} from an Every space group.`,
                title: `Remove ${first(m)}'s manually added role?`,
                body: `${first(m)} goes from ${ROLE_LABEL[m.manualRole]} to ${ROLE_LABEL[every]}. They keep ${ROLE_LABEL[every]} from an Every space group.`,
                button: "Remove role",
              }
            : m.manualRole && m.syncRole
              ? {
                  item: "Remove manually added role…",
                  hint: `Also synced from ${syncShort(m)}. ${first(m)} keeps ${ROLE_LABEL[m.syncRole]} through it.`,
                  title: `Remove ${first(m)}'s manually added role?`,
                  body: `${first(m)} goes from ${ROLE_LABEL[m.manualRole]} to ${ROLE_LABEL[m.syncRole]}, the role ${syncShort(m)} gives. To take ${first(m)} out of the space, change ${syncShort(m)} in Google or under Who gets access.`,
                  button: "Remove role",
                }
              : m.manualRole
                ? {
                    item: `Remove from ${space.name}…`,
                    title: `Remove ${name} from ${space.name}?`,
                    body: m.allMembers
                      ? `${first(m)} keeps ${ROLE_LABEL[m.allMembers]} through All members. Artifacts ${first(m)} made here stay in the space.`
                      : `${first(m)} loses access to ${space.name} within a minute. Artifacts ${first(m)} made here stay in the space.`,
                    button: "Remove",
                  }
                : null;
  const syncedOnly =
    canAct && !removal && !!m.syncRole && !frozen && !everyOnly(m);
  const manage = admin && !active;
  const menu = !!removal || syncedOnly || manage;

  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-[10px] gap-y-[6px] border-0 border-t border-border py-[var(--oa-space-2)] first:border-t-0 max-[600px]:grid-cols-[minmax(0,1fr)]">
      <div className="flex min-w-0 items-center gap-[10px]">
        <UserAvatar
          name={m.user.name ?? undefined}
          email={m.user.email ?? ""}
        />
        <div className="min-w-0">
          <b className="flex min-w-0 flex-wrap items-center gap-[6px] font-medium">
            <span className="truncate">{name}</span>
            {you && <span className="text-muted-foreground"> (you)</span>}
            {m.cap === "restricted" && (
              <Badge
                variant="outline"
                data-tone="warning"
                className="border-transparent bg-[var(--oa-warning-soft)] text-[var(--oa-warning)]"
              >
                Restricted
              </Badge>
            )}
            {m.cap === "guest" && (
              <>
                <Badge variant="outline">Guest</Badge>
                <span className="sr-only">
                  {name}, guest, can only view. Guests sign in by link and can't
                  publish, edit or write live data, from the app or any AI
                  agent.
                </span>
              </>
            )}
            {m.status === "suspended" && (
              <Badge variant="outline">Suspended</Badge>
            )}
            {m.status === "removed" && <Badge variant="outline">Removed</Badge>}
          </b>
          <small className={`block ${muted}`}>
            {m.user.email} · {reason(m, frozen, restricted)}
          </small>
        </div>
      </div>
      <div className="flex items-center justify-end gap-[var(--oa-space-1)] max-[600px]:justify-start">
        {select ? (
          <RoleSelect
            label={`Role for ${name}`}
            value={shown}
            roles={options}
            labels={label}
            onChange={(r) => r && change(r)}
          />
        ) : (
          <span className="px-[var(--oa-space-2)] text-[length:var(--oa-text-sm)] max-[600px]:pl-0">
            {ROLE_LABEL[capped ? "viewer" : m.role]}
          </span>
        )}
        {menu && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" aria-label={`More for ${name}`}>
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
              {removal && (
                <DropdownMenuItem
                  onSelect={() => setAsking(true)}
                  className="flex-col items-start gap-0"
                >
                  <span>{removal.item}</span>
                  {"hint" in removal && removal.hint && (
                    <small className={muted}>{removal.hint}</small>
                  )}
                </DropdownMenuItem>
              )}
              {syncedOnly && (
                <DropdownMenuItem
                  disabled
                  className="flex-col items-start gap-0"
                >
                  <span>Synced from {syncShort(m)}</span>
                  <small className={muted}>
                    Change it in Google, or under Who gets access
                  </small>
                </DropdownMenuItem>
              )}
              {manage && (
                <DropdownMenuItem asChild>
                  <AppLink href="/settings/members">Manage in Members</AppLink>
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {everyOnly(m) && active && !problem && (
        <p className={`col-span-full m-0 ${muted}`}>
          {admin ? (
            <>
              {SET_BY_EVERY} Change it in{" "}
              <AppLink href={EVERY_SPACE} className="underline">
                Settings › Spaces › Every space
              </AppLink>
              .
            </>
          ) : (
            everyLine(false)
          )}
        </p>
      )}
      {problem && (
        <p role="alert" className={`col-span-full m-0 ${errorText}`}>
          {problem}
        </p>
      )}
      {removal && (
        <ConfirmDialog
          open={asking}
          onClose={() => setAsking(false)}
          title={removal.title}
          body={<p>{removal.body}</p>}
          confirm={removal.button}
          onConfirm={remove}
        />
      )}
    </li>
  );
}

const ROLE_HELP: Record<SpaceRole, string> = {
  viewer: "Can view artifacts in this space.",
  editor: "Can also publish and edit here.",
  manager: "Can also add people and change roles.",
};

/**
 * Add people: org members only (guests come in by link), searched through
 * R.spaceCandidates (open to the space's managers, not only admins); one PUT each.
 */
function AddPeople({
  space,
  admin,
  orgName,
  onClose,
}: {
  space: Space;
  admin: boolean;
  orgName: string;
  onClose: () => void;
}) {
  const put = usePutSpaceMember(space.id);
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  // Debounced: the search follows the typing, not every key.
  useEffect(() => {
    const t = setTimeout(() => setTerm(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const members = useSpaceCandidates(space.id, term);
  const [picked, setPicked] = useState<SpaceCandidate[]>([]);
  const [role, setRole] = useState<SpaceRole>("viewer");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(-1);
  const id = useId();
  const roles = admin ? ALL_ROLES : ALL_ROLES.filter((r) => r !== "manager");
  // The server only returns active org members; hide the picked ones, and
  // anything left over from before the box was cleared.
  const found =
    q.trim() === ""
      ? []
      : (members.data?.items ?? []).filter(
          (m) => !picked.some((p) => p.id === m.id),
        );
  const already = (m: SpaceCandidate) => m.spaceRole;
  const pick = (m: SpaceCandidate) => {
    if (already(m)) return;
    setPicked((p) => [...p, m]);
    setQ("");
    setActive(-1);
    setError(null);
  };
  const capped = picked.filter((m) => m.restriction);

  const submit = async () => {
    if (picked.length === 0) return setError("Pick at least one person.");
    setBusy(true);
    setError(null);
    const failed: string[] = [];
    for (const m of picked) {
      try {
        await put.mutateAsync({ userId: m.id, role });
      } catch (e) {
        const who = displayName(m).split(/\s+/)[0] ?? displayName(m);
        failed.push(
          e instanceof ApiClientError && e.code === "not_found"
            ? `${who} can't be added: ${who}'s account isn't active.`
            : `Couldn't add ${who}. Try again.`,
        );
      }
    }
    setBusy(false);
    if (failed.length) setError(failed.join(" "));
    else onClose();
  };

  return (
    <Modal
      onClose={onClose}
      sheetOnPhone
      title={`Add people to ${space.name}`}
      description="They get access within a minute. Recorded in the audit log."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void submit()}>
            {picked.length === 0 ? "Add" : `Add ${people(picked.length)}`}
          </Button>
        </>
      }
    >
      <div className="grid gap-[var(--oa-space-3)] text-[length:var(--oa-text-sm)]">
        <div className="grid gap-[6px]">
          <span id={`${id}-people`} className="font-medium">
            People
          </span>
          {picked.length > 0 && (
            <ul className="flex flex-wrap gap-[6px] p-0">
              {picked.map((m) => (
                <li key={m.id}>
                  <Badge variant="outline" className="gap-[4px]">
                    {displayName(m)}
                    <button
                      type="button"
                      aria-label={`Remove ${displayName(m)}`}
                      onClick={() =>
                        setPicked((p) => p.filter((x) => x.id !== m.id))
                      }
                    >
                      ×
                    </button>
                  </Badge>
                </li>
              ))}
            </ul>
          )}
          <div className="relative">
            <Input
              role="combobox"
              aria-labelledby={`${id}-people`}
              aria-expanded={found.length > 0}
              aria-controls={`${id}-list`}
              aria-autocomplete="list"
              aria-activedescendant={
                active >= 0 && found[active] ? `${id}-o${active}` : undefined
              }
              placeholder={`Search people at ${orgName}`}
              value={q}
              autoComplete="off"
              onChange={(e) => {
                setQ(e.target.value);
                setActive(-1);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  if (!found.length) return;
                  const step = e.key === "ArrowDown" ? 1 : -1;
                  setActive((i) => (i + step + found.length) % found.length);
                } else if (e.key === "Enter" && found[active]) {
                  e.preventDefault();
                  pick(found[active]);
                }
              }}
            />
            {found.length > 0 && (
              <div
                id={`${id}-list`}
                role="listbox"
                aria-labelledby={`${id}-people`}
                className="absolute inset-x-0 top-[calc(100%+4px)] z-20 max-h-[220px] overflow-y-auto rounded-md border border-border bg-popover p-[var(--oa-space-1)] shadow-md"
              >
                {found.map((m, i) => {
                  const h = already(m);
                  return (
                    // Keyboard lives on the combobox (aria-activedescendant).
                    // biome-ignore lint/a11y/useKeyWithClickEvents: see above
                    <div
                      key={m.id}
                      id={`${id}-o${i}`}
                      role="option"
                      tabIndex={-1}
                      aria-selected={i === active}
                      aria-disabled={h ? true : undefined}
                      className="flex cursor-pointer items-center gap-[var(--oa-space-2)] rounded-sm px-[var(--oa-space-2)] py-[6px] aria-disabled:cursor-default aria-disabled:opacity-60 aria-selected:bg-accent hover:bg-accent"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pick(m)}
                    >
                      <span className="min-w-0 flex-1">
                        <b className="block font-medium">{displayName(m)}</b>
                        <small className={`block ${muted}`}>
                          {m.email}
                          {h && ` · Already here as ${ROLE_LABEL[h]}`}
                        </small>
                      </span>
                      {m.restriction && (
                        <Badge
                          variant="outline"
                          className="border-transparent bg-[var(--oa-warning-soft)] text-[var(--oa-warning)]"
                        >
                          Restricted
                        </Badge>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {/* Under the box, so the typed search stays for Retry. */}
          {members.isError && (
            <LoadError
              title="Couldn't load the people you can add."
              error={members.error}
              onRetry={() => void members.refetch()}
            />
          )}
        </div>
        <fieldset className="grid gap-[var(--oa-space-2)] border-0 p-0">
          <legend className="mb-[6px] font-medium">Role</legend>
          {roles.map((r) => (
            <label key={r} className="flex items-start gap-[var(--oa-space-2)]">
              <input
                type="radio"
                name={`${id}-role`}
                checked={role === r}
                onChange={() => setRole(r)}
                className="mt-[3px]"
              />
              <span>
                {ROLE_LABEL[r]}
                <small className={`block ${muted}`}>{ROLE_HELP[r]}</small>
              </span>
            </label>
          ))}
        </fieldset>
        {capped.map((m) => (
          <p key={m.id} className={`m-0 ${muted}`}>
            {displayName(m)} can only view, whatever the role
            {m.restriction?.groups.length
              ? `: restricted via ${m.restriction.groups.map((g) => g.name ?? g.email).join(", ")}`
              : ""}
            .
          </p>
        ))}
        {error && (
          <p role="alert" className={`m-0 ${errorText}`}>
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

const dateFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

export function SpacePeople({
  space,
  admin,
  orgName,
  frozen,
  group,
  onGroup,
}: {
  space: Space;
  admin: boolean;
  orgName: string;
  /** Group sync is frozen (sync_frozen): kept rows are edited manually. */
  frozen: boolean;
  /** A groupId the list is narrowed to (frozen "Edit people"), or "". */
  group: string;
  onGroup: (groupId: string) => void;
}) {
  const state = useMe();
  const meId = state.status === "authed" ? state.me.user.id : null;
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [adding, setAdding] = useState(false);
  // Debounced: the list request follows the typing, not every key.
  useEffect(() => {
    const t = setTimeout(() => setTerm(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const list = useSpaceMembers(space.id, { q: term, group });
  const everyone = useSpaceMembers(space.id, {}, term !== "" || group !== "");
  const mappings = useSpaceMappings(space.id);
  const rows = [...(list.data?.pages.flatMap((p) => p.items) ?? [])].sort(
    order,
  );
  const total = list.data?.pages[0]?.total ?? 0;
  const allTotal =
    term || group ? (everyone.data?.pages[0]?.total ?? 0) : total;
  const filtered = mappings.data?.find((g) => g.groupId === group);

  return (
    <SettingsCard
      id="oa-space-people"
      title="People"
      action={
        <Button
          size="sm"
          className="text-[length:var(--oa-text-sm)]"
          onClick={() => setAdding(true)}
        >
          Add people
        </Button>
      }
    >
      {space.allMembersRole && (
        <p className={muted}>
          Everyone at {orgName} can also {VERB[space.allMembersRole]} through
          All members. They aren't listed.
        </p>
      )}
      {!admin &&
        rows.some((r) => r.role === "manager" && r.userId !== meId) && (
          <p className={muted}>{MANAGER_ONLY}</p>
        )}
      {frozen && (
        <p className={muted}>
          Group sync is off. Everyone below was kept as of the last sync and is
          edited manually.
        </p>
      )}
      {(allTotal > SEARCH_FROM || q) && (
        <Input
          type="search"
          aria-label={`Search people in ${space.name}`}
          placeholder={`Search people in ${space.name}`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      )}
      {group && (
        <div className="flex flex-wrap items-center justify-between gap-[var(--oa-space-2)]">
          <span className="text-[length:var(--oa-text-sm)]">
            {people(total)} from {short(filtered?.email ?? "")}
            {filtered?.lastSyncedAt &&
              ` as of ${dateFmt.format(new Date(filtered.lastSyncedAt))}`}
            {filtered && ` · ${ROLE_LABEL[filtered.role]}`}
          </span>
          {/* No padding: wrapped on a phone, it lines up with the header text. */}
          <Button
            size="sm"
            variant="ghost"
            className="h-auto px-0 text-[length:var(--oa-text-sm)] underline-offset-2 hover:bg-transparent hover:underline"
            onClick={() => onGroup("")}
          >
            Show everyone
          </Button>
        </div>
      )}
      {list.isError && (
        <p role="alert" className={errorText}>
          Couldn't load people. Try again.
        </p>
      )}
      <ul className="grid p-0">
        {rows.map((m) => (
          <PersonRow
            key={m.userId}
            m={m}
            space={space}
            admin={admin}
            you={m.userId === meId}
            frozen={frozen}
            restricted={m.restriction}
          />
        ))}
      </ul>
      {list.hasNextPage && (
        <div className="flex flex-wrap items-center justify-between gap-[var(--oa-space-2)]">
          <span className={muted}>
            Showing {rows.length} of {total}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            Load more
          </Button>
        </div>
      )}
      {adding && (
        <AddPeople
          space={space}
          admin={admin}
          orgName={orgName}
          onClose={() => setAdding(false)}
        />
      )}
    </SettingsCard>
  );
}
