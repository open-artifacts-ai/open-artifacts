// `/settings/spaces` (hosted P4 Task 10), Design D5 as drawn: the list of
// shared spaces (never personal ones), each opening at ?space=<id>, plus, for
// org admins, the Every space card and the "Space managers can map groups"
// switch (Backend #422). Space managers who aren't admins see only their
// spaces and only what SPACE_MANAGER_FIELDS lets them change.
import { Badge, Button, Input, Label } from "@oa/ui/shadcn";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import { ApiClientError } from "../../api/client";
import { directoryMode, type Space, type SpaceRole } from "../../api/contract";
import { errorCopy } from "../../api/errorCopy";
import {
  useAddSelfToSpace,
  useCreateSpace,
  useDeleteOrgMapping,
  useDeleteSpace,
  useOrgMappings,
  usePatchSpace,
  usePutOrgMapping,
  useSettings,
  useSpaces,
  useUpdateSettings,
} from "../../api/queries";
import { useMe } from "../../auth/useMe";
import { LoadError } from "../../layout/LoadError";
import { Modal } from "../../layout/Modal";
import { useDocumentTitle } from "../../layout/useDocumentTitle";
import { AppLink } from "../../library/AppLink";
import { ConfirmDialog } from "../ConfirmDialog";
import { GroupPicker } from "../GroupPicker";
import { errorText, muted, SettingsCard, STACK } from "../ui";
import { isOrgAdmin } from "./access";
import { checkName, nameRefusal } from "./name";
import {
  AccessRow,
  ALL_ROLES,
  mappingProblem,
  Problem,
  people,
  ROLE_LABEL,
  RoleSelect,
  SpaceAccess,
} from "./SpaceAccess";
import { SpacePeople } from "./SpacePeople";
import { Switch } from "./Switch";

const PAGE = "/settings/spaces";

const yourRole: Record<SpaceRole, string> = {
  viewer: "You're a viewer",
  editor: "You're an editor",
  manager: "You're a manager",
};

const counts = (s: Space) =>
  `${people(s.memberCount)} · ${s.artifactCount} ${s.artifactCount === 1 ? "artifact" : "artifacts"}`;

// -- list

function NewSpace({
  orgName,
  onClose,
}: {
  orgName: string;
  onClose: () => void;
}) {
  const create = useCreateSpace();
  const [name, setName] = useState("");
  const [allMembersRole, setAll] = useState<SpaceRole | null>(null);
  const [publicLinks, setPublic] = useState(true);
  const [touched, setTouched] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const hint = useId();
  const nameId = useId();
  const checked = checkName(name);
  // After the field was left or a submit was tried, never on a fresh form.
  const error = (touched ? checked.error : null) ?? refused;
  const submit = () => {
    setTouched(true);
    const clean = checked.name;
    if (clean === null) return;
    setRefused(null);
    create.mutate(
      { name: clean, allMembersRole, publicLinks },
      {
        onSuccess: onClose,
        onError: (e) => setRefused(nameRefusal(e, name)),
      },
    );
  };
  return (
    <Modal
      onClose={onClose}
      title="New space"
      description="Choose a name and who gets access."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={create.isPending} onClick={submit}>
            Create space
          </Button>
        </>
      }
    >
      <form
        className="grid gap-[var(--oa-space-3)]"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="grid gap-[6px]">
          <Label htmlFor="oa-new-space-name">Name</Label>
          <Input
            id="oa-new-space-name"
            value={name}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? nameId : undefined}
            onBlur={() => setTouched(true)}
            onChange={(e) => {
              setName(e.target.value);
              setRefused(null);
            }}
          />
          {error && (
            <p id={nameId} role="alert" className={`m-0 ${errorText}`}>
              {error}
            </p>
          )}
        </div>
        <div className="grid gap-[6px]">
          <span className="text-[length:var(--oa-text-sm)] font-medium">
            All members
          </span>
          <RoleSelect
            label="All members"
            value={allMembersRole}
            roles={ALL_ROLES}
            none
            onChange={setAll}
          />
          <small id={hint} className={muted}>
            Everyone at {orgName} gets this role. Leave None to give access
            through groups or by adding people manually.
          </small>
        </div>
        <div className="flex items-center justify-between gap-[var(--oa-space-3)]">
          <span className="text-[length:var(--oa-text-sm)] font-medium">
            Public links
          </span>
          <Switch
            label="Public links"
            checked={publicLinks}
            onChange={setPublic}
          />
        </div>
      </form>
    </Modal>
  );
}

function AccessSwitch() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const on = settings.data?.spaceManagerMappings;
  if (on === undefined) return null; // not hosted, or not loaded
  return (
    <SettingsCard id="oa-spaces-access" title="Access">
      <div className="flex items-start justify-between gap-[var(--oa-space-3)]">
        <div>
          <b className="block text-[length:var(--oa-text-sm)] font-medium">
            Space managers can map groups
          </b>
          <small id="oa-spaces-access-hint" className={muted}>
            To spaces they manage, as Viewer or Editor. Every change is audited.
          </small>
        </div>
        <Switch
          label="Space managers can map groups"
          describedBy="oa-spaces-access-hint"
          checked={on}
          disabled={update.isPending}
          onChange={(next) => update.mutate({ spaceManagerMappings: next })}
        />
      </div>
    </SettingsCard>
  );
}

function EverySpace({ syncOn }: { syncOn: boolean }) {
  const org = useOrgMappings();
  const put = usePutOrgMapping();
  const remove = useDeleteOrgMapping();
  const [pending, setPending] = useState<Record<string, SpaceRole>>({});
  const [problem, setProblem] = useState<ReturnType<
    typeof mappingProblem
  > | null>(null);
  const rows = org.data ?? [];
  const change = (groupId: string, role: SpaceRole) => {
    setProblem(null);
    setPending((p) => ({ ...p, [groupId]: role }));
    put.mutate(
      { groupId, role },
      {
        onError: (e) => setProblem(mappingProblem(e)),
        onSettled: () => setPending(({ [groupId]: _, ...rest }) => rest),
      },
    );
  };
  return (
    <SettingsCard id="oa-every-space" title="Every space">
      <p className={muted}>
        Groups here get their role in every shared space, including ones created
        later. Never in anyone's Personal space.
      </p>
      {org.isError && (
        <LoadError
          title="Couldn't load the groups for every space."
          error={org.error}
          onRetry={() => void org.refetch()}
        />
      )}
      {rows.length > 0 && (
        <table
          aria-label="Every space groups"
          className="w-full border-collapse"
        >
          <tbody>
            {rows.map((g) => (
              <AccessRow
                key={g.groupId}
                who={g.email}
                meta={[
                  g.name,
                  g.memberCount !== null ? people(g.memberCount) : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                control={
                  syncOn ? (
                    <>
                      <RoleSelect
                        label={`Role for ${g.email}`}
                        value={pending[g.groupId] ?? g.role}
                        roles={ALL_ROLES}
                        onChange={(r) => r && change(g.groupId, r)}
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-[length:var(--oa-text-sm)]"
                        aria-label={`Remove ${g.email}`}
                        onClick={() => {
                          setProblem(null);
                          remove.mutate(g.groupId, {
                            onError: (e) => setProblem(mappingProblem(e)),
                          });
                        }}
                      >
                        Remove
                      </Button>
                    </>
                  ) : (
                    <span className="text-[length:var(--oa-text-sm)]">
                      {ROLE_LABEL[g.role]}
                    </span>
                  )
                }
              />
            ))}
          </tbody>
        </table>
      )}
      {syncOn && (
        <GroupPicker
          label="Add a group to every space"
          placeholder="Add a group…"
          exclude={rows.map((g) => g.groupId)}
          disabled={put.isPending}
          onPick={(g) => {
            setProblem(null);
            put.mutate(
              { groupId: g.groupId, role: "viewer" },
              { onError: (e) => setProblem(mappingProblem(e)) },
            );
          }}
        />
      )}
      <Problem problem={problem} />
    </SettingsCard>
  );
}

function SpaceList({
  spaces,
  admin,
  error,
  onRetry,
  onNew,
}: {
  spaces: Space[];
  admin: boolean;
  /** The list failed to load: said instead of the count and rows. */
  error: unknown;
  onRetry: () => void;
  onNew: () => void;
}) {
  return (
    <SettingsCard
      id="oa-spaces-list"
      title="Spaces"
      action={
        admin && (
          <Button
            size="sm"
            className="text-[length:var(--oa-text-sm)]"
            onClick={onNew}
          >
            New space
          </Button>
        )
      }
    >
      {error ? (
        <LoadError
          title="Couldn't load spaces."
          error={error}
          onRetry={onRetry}
        />
      ) : (
        admin && (
          <p className={muted}>
            {spaces.length} shared {spaces.length === 1 ? "space" : "spaces"}.
            Personal spaces aren't listed.
          </p>
        )
      )}
      <ul aria-label="Spaces" className="grid p-0">
        {spaces.map((s) => (
          <li
            key={s.id}
            className="border-0 border-t border-border first:border-t-0"
          >
            <AppLink
              href={`${PAGE}?space=${encodeURIComponent(s.id)}`}
              className="flex flex-wrap items-center justify-between gap-[var(--oa-space-2)] py-[var(--oa-space-3)] hover:underline"
            >
              <span className="min-w-0">
                <h3 className="font-medium">{s.name}</h3>
                <small className={`block ${muted}`}>{counts(s)}</small>
              </span>
              <span className="flex flex-wrap items-center gap-[6px]">
                {!s.publicLinks && (
                  <span
                    data-status="muted"
                    className={`inline-flex items-center gap-[4px] ${muted}`}
                  >
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 16 16"
                      width="12"
                      height="12"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    >
                      <path d="M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1M2.5 2.5l11 11" />
                    </svg>
                    Public links off
                  </span>
                )}
                <Badge variant="outline">
                  {s.myRole ? ROLE_LABEL[s.myRole] : "No role for you"}
                </Badge>
              </span>
            </AppLink>
          </li>
        ))}
      </ul>
    </SettingsCard>
  );
}

// -- one space

function General({ space }: { space: Space }) {
  const patch = usePatchSpace(space.id);
  const [name, setName] = useState(space.name);
  const [asking, setAsking] = useState(false);
  useEffect(() => setName(space.name), [space.name]);
  const nameId = useId();
  const [refused, setRefused] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const checked = checkName(name);
  const error = (touched ? checked.error : null) ?? refused;
  const same = checked.name === space.name;
  return (
    <SettingsCard id="oa-space-general" title="General">
      <form
        className="grid gap-[6px]"
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (!checked.name || same) return;
          setRefused(null);
          patch.mutate(
            { name: checked.name },
            {
              // The saved name, cleaned, is what the field shows.
              onSuccess: (s) => setName(s.name),
              onError: (e) => setRefused(nameRefusal(e, name)),
            },
          );
        }}
      >
        <Label htmlFor="oa-space-name">Name</Label>
        <div className="flex gap-[var(--oa-space-2)]">
          <Input
            id="oa-space-name"
            value={name}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? nameId : undefined}
            onBlur={() => setTouched(true)}
            onChange={(e) => {
              setName(e.target.value);
              setRefused(null);
            }}
          />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            className="h-auto text-[length:var(--oa-text-sm)]"
            disabled={!checked.name || same || patch.isPending}
          >
            Save name
          </Button>
        </div>
        {error && (
          <p id={nameId} role="alert" className={`m-0 ${errorText}`}>
            {error}
          </p>
        )}
      </form>
      <div className="flex items-start justify-between gap-[var(--oa-space-3)]">
        <div>
          <b className="block text-[length:var(--oa-text-sm)] font-medium">
            Public links
          </b>
          <small id="oa-space-public-hint" className={muted}>
            Anyone with the link can view, no sign-in.
          </small>
        </div>
        <Switch
          label="Public links"
          describedBy="oa-space-public-hint"
          checked={space.publicLinks}
          disabled={patch.isPending}
          onChange={(next) =>
            next ? patch.mutate({ publicLinks: true }) : setAsking(true)
          }
        />
      </div>
      <ConfirmDialog
        open={asking}
        onClose={() => setAsking(false)}
        title={`Turn off public links in ${space.name}?`}
        body={
          <>
            <p>
              No one can make new public links in {space.name}. Public links
              already here keep working.
            </p>
            <p>
              To stop an existing link, open the artifact and make it private.
            </p>
          </>
        }
        confirm="Turn off public links"
        onConfirm={() => patch.mutate({ publicLinks: false })}
      />
    </SettingsCard>
  );
}

function AddMe({ space }: { space: Space }) {
  const add = useAddSelfToSpace(space.id);
  const [asking, setAsking] = useState(false);
  const [role, setRole] = useState<SpaceRole>("viewer");
  return (
    <div className="grid gap-[var(--oa-space-2)]">
      <p className="text-[length:var(--oa-text-sm)]">
        You can manage {space.name}' settings and groups, but you can't open its
        artifacts.
      </p>
      <div>
        <Button
          size="sm"
          variant="outline"
          className="text-[length:var(--oa-text-sm)]"
          onClick={() => setAsking(true)}
        >
          Add me to this space
        </Button>
      </div>
      <ConfirmDialog
        open={asking}
        onClose={() => setAsking(false)}
        title={`Add yourself to ${space.name}?`}
        body={
          <>
            <p>
              You'll be able to open its artifacts. Space managers are told, and
              it's recorded in the audit log.
            </p>
            <div className="flex items-center justify-between gap-[var(--oa-space-3)]">
              <span className="font-medium">Your role</span>
              <RoleSelect
                label="Your role"
                value={role}
                roles={ALL_ROLES}
                onChange={(r) => r && setRole(r)}
              />
            </div>
          </>
        }
        confirm="Add me"
        onConfirm={() => add.mutate({ role })}
      />
    </div>
  );
}

function DeleteSpace({
  space,
  onDeleted,
}: {
  space: Space;
  onDeleted: () => void;
}) {
  const del = useDeleteSpace();
  const [asking, setAsking] = useState(false);
  const reason = useId();
  // artifactCount is live artifacts only: an "empty" space can still hold
  // trash, so the server's space_not_empty stays the authority.
  const n = space.artifactCount;
  const refusal =
    del.error instanceof ApiClientError && del.error.code === "space_not_empty"
      ? errorCopy(del.error, "")
      : null;
  return (
    <SettingsCard id="oa-space-delete" title="Delete space">
      <p className={muted}>
        Only an empty space can be deleted, trash included.
      </p>
      <div className="flex flex-wrap items-center gap-[var(--oa-space-3)]">
        <Button
          size="sm"
          variant="outline"
          className="text-[length:var(--oa-text-sm)] text-destructive"
          disabled={n > 0}
          aria-describedby={n > 0 ? reason : undefined}
          onClick={() => setAsking(true)}
        >
          Delete space
        </Button>
        {n > 0 && (
          <small id={reason} className={muted}>
            Move or delete its {n} {n === 1 ? "artifact" : "artifacts"} first
            (trash included).
          </small>
        )}
      </div>
      {refusal && (
        <p role="alert" className={errorText}>
          {refusal}
        </p>
      )}
      <ConfirmDialog
        open={asking}
        onClose={() => setAsking(false)}
        title={`Delete ${space.name}?`}
        body={
          <p>
            {space.name} is empty, so nothing else is deleted. This can't be
            undone.
          </p>
        }
        confirm="Delete space"
        danger
        onConfirm={() => del.mutate(space.id, { onSuccess: onDeleted })}
      />
    </SettingsCard>
  );
}

function SpaceDetail({
  space,
  admin,
  syncOn,
  orgName,
  onDeleted,
}: {
  space: Space;
  admin: boolean;
  syncOn: boolean;
  orgName: string;
  onDeleted: () => void;
}) {
  useDocumentTitle(space.name);
  const state = useMe();
  const frozen =
    state.status === "authed" && directoryMode(state.me) === "frozen";
  // A kept group's "Edit people" narrows People to it.
  const [group, setGroup] = useState("");
  return (
    <div className={STACK}>
      <div className="grid gap-[var(--oa-space-2)]">
        <AppLink href={PAGE} className={`${muted} w-fit hover:underline`}>
          <span aria-hidden="true">← </span>All spaces
        </AppLink>
        <div className="flex flex-wrap items-center gap-[var(--oa-space-2)]">
          <h2 className="text-[length:var(--oa-text-lg)] font-semibold">
            {space.name}
          </h2>
          <Badge variant="outline">
            {space.myRole ? yourRole[space.myRole] : "No role for you"}
          </Badge>
          <small className={muted}>{counts(space)}</small>
        </div>
        {admin && !space.myRole && <AddMe space={space} />}
      </div>
      <General space={space} />
      <SpaceAccess
        space={space}
        admin={admin}
        syncOn={syncOn}
        orgName={orgName}
        frozen={frozen}
        onEditPeople={setGroup}
      />
      {/* People: org admins and the space's managers (D6). */}
      {(admin || space.myRole === "manager") && (
        <SpacePeople
          space={space}
          admin={admin}
          orgName={orgName}
          frozen={frozen}
          group={group}
          onGroup={setGroup}
        />
      )}
      {admin && <DeleteSpace space={space} onDeleted={onDeleted} />}
    </div>
  );
}

// -- the page

export function Spaces() {
  useDocumentTitle("Spaces");
  const state = useMe();
  const me = state.status === "authed" ? state.me : null;
  const admin = isOrgAdmin(me);
  const syncOn = !!me && directoryMode(me) === "google";
  const orgName = me?.instance.name ?? "your organization";
  const { space: spaceId } = useSearch({ strict: false }) as { space?: string };
  const navigate = useNavigate();
  const list = useSpaces({ kind: "shared" });
  const [creating, setCreating] = useState(false);

  const all = (list.data?.pages.flatMap((p) => p.items) ?? [])
    .filter((s) => s.kind === "shared")
    .filter((s) => admin || s.myRole === "manager")
    .sort((a, b) => a.name.localeCompare(b.name));
  const space = spaceId ? all.find((s) => s.id === spaceId) : undefined;
  const loaded = list.isSuccess && !list.hasNextPage;
  const toList = () =>
    void navigate({ to: PAGE as string, search: {}, replace: true });

  // A personal, unknown or unmanaged id never opens: the param clears.
  const refused = !!spaceId && loaded && !space;
  useEffect(() => {
    if (refused) toList();
  });
  useEffect(() => {
    // A failed page stops here: Retry refetches.
    if (list.hasNextPage && !list.isFetching && !list.isError)
      void list.fetchNextPage();
  }, [list]);

  if (space)
    return (
      <SpaceDetail
        space={space}
        admin={admin}
        syncOn={syncOn}
        orgName={orgName}
        onDeleted={toList}
      />
    );
  return (
    <div className={STACK}>
      {admin && <EverySpace syncOn={syncOn} />}
      <SpaceList
        spaces={all}
        admin={admin}
        error={list.isError ? list.error : null}
        onRetry={() => void list.refetch()}
        onNew={() => setCreating(true)}
      />
      {admin && <AccessSwitch />}
      {creating && (
        <NewSpace orgName={orgName} onClose={() => setCreating(false)} />
      )}
    </div>
  );
}
