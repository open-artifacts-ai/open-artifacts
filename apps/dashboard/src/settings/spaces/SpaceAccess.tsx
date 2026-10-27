// "Who gets access" for one shared space (hosted P4 Task 11, Design D5):
// "All members" first (org admins), then the space's group mappings, then
// read-only Every space rows. Space managers who aren't admins map groups to
// their own space as Viewer or Editor while Settings.spaceManagerMappings is
// on (Space.can.manageMappings, Backend #422). Role changes are optimistic and
// snap back on a refusal, which shows by the table.
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@oa/ui/shadcn";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiClientError } from "../../api/client";
import type { GroupMapping, Space, SpaceRole } from "../../api/contract";
import { errorCopy, errorLink } from "../../api/errorCopy";
import {
  qk,
  useDeleteMapping,
  useOrgMappings,
  usePatchSpace,
  usePutMapping,
  useSpaceMappings,
} from "../../api/queries";
import { LoadError } from "../../layout/LoadError";
import { AppLink } from "../../library/AppLink";
import { GroupPicker } from "../GroupPicker";
import { errorText, muted, SettingsCard } from "../ui";

export const ROLE_LABEL: Record<SpaceRole, string> = {
  viewer: "Viewer",
  editor: "Editor",
  manager: "Manager",
};
export const ALL_ROLES: SpaceRole[] = ["viewer", "editor", "manager"];
/** What a space manager may map a group to (SPACE_MANAGER_MAPPING_ROLES). */
const MANAGER_ROLES: SpaceRole[] = ["viewer", "editor"];

export const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;
const groupMeta = (g: GroupMapping) =>
  [g.name, g.memberCount !== null ? people(g.memberCount) : null]
    .filter(Boolean)
    .join(" · ");

/** A role picker; `none` adds a "None" choice (for All members). */
export function RoleSelect({
  label,
  value,
  roles,
  none,
  disabled,
  labels = (r) => ROLE_LABEL[r],
  onChange,
}: {
  label: string;
  value: SpaceRole | null;
  roles: SpaceRole[];
  none?: boolean;
  disabled?: boolean;
  /** Each role's option text (default: the role's name). */
  labels?: (role: SpaceRole) => string;
  onChange: (role: SpaceRole | null) => void;
}) {
  return (
    <Select
      value={value ?? "none"}
      disabled={disabled}
      onValueChange={(v) => onChange(v === "none" ? null : (v as SpaceRole))}
    >
      <SelectTrigger
        aria-label={label}
        size="sm"
        className="w-[120px] text-[length:var(--oa-text-sm)]"
      >
        {/* The trigger names the role; the options can say more. */}
        <SelectValue>
          {value ? ROLE_LABEL[value] : none ? "None" : undefined}
        </SelectValue>
      </SelectTrigger>
      <SelectContent position="popper">
        {none && (
          <SelectItem value="none" className="text-[length:var(--oa-text-sm)]">
            None
          </SelectItem>
        )}
        {roles.map((r) => (
          <SelectItem
            key={r}
            value={r}
            className="text-[length:var(--oa-text-sm)]"
          >
            {labels(r)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** space_forbidden { target: "mapping" }: the row changed under the editor. */
const isMappingRace = (e: unknown) =>
  e instanceof ApiClientError &&
  e.code === "space_forbidden" &&
  (e.details as { target?: string } | undefined)?.target === "mapping";

/** What a refused mapping change says, and its link (sync off points to Directory). */
export const mappingProblem = (e: unknown) => {
  if (e instanceof ApiClientError && e.code === "space_forbidden")
    return {
      text: isMappingRace(e)
        ? "This group's access just changed. Check it and try again."
        : "Only an admin can make a group a manager.",
      link: null,
    };
  return {
    text: errorCopy(e, "Couldn't change access. Try again."),
    link: errorLink(e),
  };
};

export function Problem({
  problem,
}: {
  problem: { text: string; link: { label: string; to: string } | null } | null;
}) {
  if (!problem) return null;
  return (
    <p role="alert" className={errorText}>
      {problem.text}
      {problem.link && (
        <>
          {" "}
          <AppLink href={problem.link.to} className="underline">
            {problem.link.label}
          </AppLink>
        </>
      )}
    </p>
  );
}

/** One table row: who, then the control (or the read-only role). */
export function AccessRow({
  who,
  meta,
  control,
  note,
}: {
  who: string;
  meta: string;
  control: React.ReactNode;
  /** A refusal for this row, shown right under it. */
  note?: string | null;
}) {
  return (
    <>
      <tr className="border-0 border-t border-border first:border-t-0">
        <td className="min-w-0 py-[var(--oa-space-3)] pr-[var(--oa-space-3)]">
          <b className="block truncate font-medium">{who}</b>
          <small className={`block truncate ${muted}`}>{meta}</small>
        </td>
        <td className="py-[var(--oa-space-3)]">
          <div className="flex flex-wrap items-center justify-end gap-[var(--oa-space-2)]">
            {control}
          </div>
        </td>
      </tr>
      {note && (
        <tr>
          <td colSpan={2} className="pb-[var(--oa-space-2)]">
            <p
              role="status"
              className="m-0 text-[length:var(--oa-text-sm)] text-[var(--oa-warning)]"
            >
              {note}
            </p>
          </td>
        </tr>
      )}
    </>
  );
}

export function SpaceAccess({
  space,
  admin,
  syncOn,
  orgName,
  frozen = false,
  onEditPeople,
}: {
  space: Space;
  admin: boolean;
  /** Group sync is running (sync_google): mappings can change. */
  syncOn: boolean;
  orgName: string;
  /** Group sync is frozen: each kept group offers "Edit people" (filters People). */
  frozen?: boolean;
  onEditPeople?: (groupId: string) => void;
}) {
  const mappings = useSpaceMappings(space.id);
  // Every-space rows: org admins only (R.orgMappings is admin-only).
  const org = useOrgMappings(admin);
  const put = usePutMapping(space.id);
  const remove = useDeleteMapping(space.id);
  const patch = usePatchSpace(space.id);
  const qc = useQueryClient();
  const [pending, setPending] = useState<Record<string, SpaceRole>>({});
  const [problem, setProblem] = useState<ReturnType<
    typeof mappingProblem
  > | null>(null);
  // A group that changed under the editor: said on its own row.
  const [rowProblem, setRowProblem] = useState<{
    groupId: string;
    text: string;
  } | null>(null);

  // The row changed under the editor: say so by the row, and reload the groups.
  const refused = (e: unknown, groupId?: string) => {
    if (groupId && isMappingRace(e)) {
      setRowProblem({ groupId, text: mappingProblem(e).text });
      void qc.invalidateQueries({ queryKey: qk.spaceMappings(space.id) });
    } else {
      setProblem(mappingProblem(e));
      if (isMappingRace(e))
        void qc.invalidateQueries({ queryKey: qk.spaceMappings(space.id) });
    }
  };

  const manager = space.myRole === "manager";
  const canMap = admin || (manager && (space.can?.manageMappings ?? false));
  const canEdit = syncOn && canMap;
  // With the switch off a space manager keeps GET and DELETE of Viewer and
  // Editor rows (#422); only adding and changing roles (PUT) is blocked.
  const mapper = syncOn && (admin || manager);
  const roles = admin ? ALL_ROLES : MANAGER_ROLES;
  const rows = mappings.data ?? [];

  const change = (groupId: string, role: SpaceRole) => {
    setProblem(null);
    setRowProblem(null);
    setPending((p) => ({ ...p, [groupId]: role }));
    put.mutate(
      { groupId, role },
      {
        onError: (e) => refused(e, groupId),
        onSettled: () => setPending(({ [groupId]: _, ...rest }) => rest),
      },
    );
  };

  return (
    <SettingsCard id="oa-space-access" title="Who gets access">
      <table aria-label="Groups" className="w-full border-collapse">
        <tbody>
          {admin && (
            <AccessRow
              who="All members"
              meta={`Everyone at ${orgName} · built in`}
              control={
                <RoleSelect
                  label="Role for All members"
                  value={space.allMembersRole}
                  roles={ALL_ROLES}
                  none
                  disabled={patch.isPending}
                  onChange={(role) => patch.mutate({ allMembersRole: role })}
                />
              }
            />
          )}
          {rows.map((g) => {
            const role = pending[g.groupId] ?? g.role;
            // A Manager row an admin set stays read-only for a space manager.
            const own = mapper && (admin || g.role !== "manager");
            return (
              <AccessRow
                key={g.groupId}
                who={g.email}
                meta={
                  !admin && g.role === "manager"
                    ? "Manager · set by an admin"
                    : groupMeta(g)
                }
                note={
                  rowProblem?.groupId === g.groupId ? rowProblem.text : null
                }
                control={
                  own ? (
                    <>
                      <RoleSelect
                        label={`Role for ${g.email}`}
                        value={role}
                        roles={roles}
                        disabled={!canEdit}
                        onChange={(r) => r && change(g.groupId, r)}
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-[length:var(--oa-text-sm)]"
                        aria-label={`Remove ${g.email}`}
                        onClick={() => {
                          setProblem(null);
                          setRowProblem(null);
                          remove.mutate(g.groupId, {
                            onError: (e) => refused(e, g.groupId),
                          });
                        }}
                      >
                        Remove
                      </Button>
                    </>
                  ) : (
                    <>
                      <span className="text-[length:var(--oa-text-sm)]">
                        {ROLE_LABEL[g.role]}
                      </span>
                      {frozen && onEditPeople && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-[length:var(--oa-text-sm)]"
                          aria-label={`Edit people from ${g.email}`}
                          onClick={() => onEditPeople(g.groupId)}
                        >
                          Edit people
                        </Button>
                      )}
                    </>
                  )
                }
              />
            );
          })}
          {(org.data ?? []).map((g) => (
            <AccessRow
              key={`every-${g.groupId}`}
              who={g.email}
              meta={[
                "via Every space",
                g.memberCount !== null ? people(g.memberCount) : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              control={
                <>
                  <span className="text-[length:var(--oa-text-sm)]">
                    {ROLE_LABEL[g.role]}
                  </span>
                  <AppLink
                    href="/settings/spaces"
                    className={`${muted} underline`}
                  >
                    Change in Every space
                  </AppLink>
                </>
              }
            />
          ))}
        </tbody>
      </table>
      {mappings.isError && (
        <LoadError
          title="Couldn't load this space's groups."
          error={mappings.error}
          onRetry={() => void mappings.refetch()}
        />
      )}
      {org.isError && (
        <LoadError
          title="Couldn't load the groups for every space."
          error={org.error}
          onRetry={() => void org.refetch()}
        />
      )}
      {mapper && (
        <GroupPicker
          label="Add a group"
          placeholder="Add a group…"
          exclude={rows.map((g) => g.groupId)}
          disabled={!canEdit || put.isPending}
          onPick={(g) => {
            setProblem(null);
            put.mutate(
              { groupId: g.groupId, role: "viewer" },
              { onError: (e) => refused(e) },
            );
          }}
        />
      )}
      {!admin && (
        // Every-space rows are admin-only to read (#422), so managers get one line.
        <p className={muted}>
          Groups an admin set for every space also get access here.
        </p>
      )}
      <Problem problem={problem} />
      <p className={muted}>
        {!syncOn
          ? "Group sync is off, so mappings can't change. Edit people manually under People."
          : admin
            ? "Someone in more than one group gets the highest role. Changes apply within a minute and are recorded in the audit log."
            : canMap
              ? "You can give a group Viewer or Editor. Only an admin can make a group a manager. Changes are recorded in the audit log."
              : "An admin has turned off group mapping by space managers. Ask an admin to add or change groups."}
      </p>
    </SettingsCard>
  );
}
