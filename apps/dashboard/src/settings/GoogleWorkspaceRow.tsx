// Settings > Connections: revoke a leftover Google Workspace grant (#2149).
// Hosted Team and the Team trial hide the Directory tab (#2113) but the server
// keeps the binding (mode "frozen"), so a Team that synced on Business has no
// other way to disconnect. Removals pass the plan gate (#2146).
import { Button } from "@oa/ui/shadcn";
import { useState } from "react";
import { useDisconnectDirectory } from "../api/queries";
import { useMe } from "../auth/useMe";
import { groupSyncHidden } from "../layout/SyncBanner";
import { ConfirmDialog } from "./ConfirmDialog";
import { muted, SettingsCard } from "./ui";

export const GOOGLE_DISCONNECT_COPY = {
  title: "Disconnect Google Workspace?",
  body: "Group sync stays off and Open Artifacts loses access to your directory. People and roles already here stay as they are.",
  done: "Google Workspace disconnected.",
} as const;

export function GoogleWorkspaceRow() {
  const state = useMe();
  const [asking, setAsking] = useState(false);
  const disconnect = useDisconnectDirectory(GOOGLE_DISCONNECT_COPY.done);
  if (state.status !== "authed") return null;
  const me = state.me;
  // Business shows the Directory tab instead. A binding keeps mode frozen
  // below Business; with none the server reports off.
  if (!groupSyncHidden(me) || me.instance.directory?.mode !== "frozen")
    return null;
  // The server's rule (directory.disconnect): the owner, uncapped.
  if (me.user.role !== "owner" || me.auth?.cap != null) return null;
  return (
    <SettingsCard id="oa-google-workspace-h" title="Google Workspace">
      <p className={`m-0 ${muted}`}>
        Open Artifacts is still connected to your Google Workspace directory.
        Group sync is off on your plan.
      </p>
      <div>
        <Button
          size="sm"
          variant="outline"
          className="text-[length:var(--oa-text-sm)] text-destructive"
          onClick={() => setAsking(true)}
        >
          Disconnect Google Workspace
        </Button>
      </div>
      <ConfirmDialog
        open={asking}
        onClose={() => setAsking(false)}
        title={GOOGLE_DISCONNECT_COPY.title}
        body={<p>{GOOGLE_DISCONNECT_COPY.body}</p>}
        confirm="Disconnect"
        danger
        onConfirm={() => disconnect.mutate()}
      />
    </SettingsCard>
  );
}
