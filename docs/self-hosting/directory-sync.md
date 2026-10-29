# Directory sync (Google Workspace)

On a self-hosted install, directory sync follows the connection: once an owner connects Google Workspace (**Settings → Directory**) and confirms it, members and groups sync from the directory. Nothing syncs before that. Code: `directoryMode` in `apps/server/src/services/spaces.ts`.

The `FEATURES` Worker var can still name a mode, and it wins over the connection:

- `sync_frozen`: keep the connection and what it synced, but stop reading groups. Synced memberships stay and admins can edit them by hand; user status is still checked.
- `sync_google`: sync while connected (the same as leaving it out).

## Stopping sync

**To stop sync, use `sync_frozen` or Disconnect.** Removing `sync_google` from `FEATURES` no longer stops it: with a live connection, sync resumes without asking, also on an install upgraded from a release where `sync_google` turned it on.

- **Freeze, keep the connection:** add `sync_frozen` to `FEATURES`.
- **Stop for good:** **Settings → Directory → Disconnect** (owner only). It revokes the Google grant, wipes the stored directory state and stops sync. Reconnecting starts over, with its own confirm.
