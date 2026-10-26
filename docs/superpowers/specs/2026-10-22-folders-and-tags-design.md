# Folders and tags

Status: draft for owner review, 2026-10-22. Target: shortly after hosted M1 (FinQore), as its own milestone.

## Why

The owner runs several things at once (open-artifacts, open-bus, medical, job hunting, and more), and every artifact lands in one flat list on their instance. Agents publish constantly, so the list gets out of hand fast. People need a place for each thing, and a way to group related things across those places.

## The rule that governs everything

**It mirrors Google Drive.** Folders, nesting, sharing, moving and their warnings behave the way Drive users already expect. Anything that behaves differently from Drive is wrong unless this document says otherwise. Tags are the one addition that Drive doesn't have (see Tags).

## Goals

- Nested folders, each artifact in exactly one folder (or at the top level), as in Drive.
- Sharing a folder shares everything in it, including things added later, as in Drive.
- Shared tags that cut across folders.
- Agents file what they publish into the right folder, as a best guess, and can tag it.
- An agent sorts the existing backlog when this ships, with the owner's approval.
- The same feature for self-hosted and hosted installs. It lives in the shared app, with no hosted-only switch.

## Non-goals (this milestone)

- Drive features beyond organizing and sharing: comments, starring, offline, and Drive's admin-defined labels.
- Shortcuts (Drive's "add shortcut"): an artifact appears in one folder only.
- Per-folder restrictions that remove access below a space's membership (Drive doesn't allow that either).
- Smart or saved searches.

## Anti-goals

- Anything that surprises a Drive user: access that changes silently on move, an artifact that appears in two folders, or sharing that doesn't flow down.
- Agents moving or re-sharing things without the owner seeing what will change.

## Model

### Where folders live

- **Self-hosted:** each person has their own library (like My Drive). Folders live in it.
- **Hosted:** folders live inside a space. A Personal space is My Drive, and a shared space is a Shared drive. (Spaces come from hosted M1; folders don't change how spaces work.)
- Every artifact is either at the top level of its library or space, or in exactly one folder. Its location is a single global value, as in Drive since 2020. It is not set per viewer.
- Ownership doesn't change with location (my call, as in Drive). If B, an editor of A's shared folder, publishes into it or moves B's own artifact into it, the artifact stays B's but now lives in A's folder, so it leaves B's top level. B, A and the folder's other editors can move it out again.
- You can't file an artifact that someone shared with you into your own folders: that would need Drive shortcuts, which are a non-goal. It appears under "Shared with me".

### Folders

- Folders nest to any depth. Name rules: 1 to 200 characters; siblings can't share a name (Drive allows duplicates, but we refuse them so agents can address folders by path; this is the one deliberate difference, flagged for the owner).
- Folders have an owner (the creator in a personal library; in a shared space, the space owns them, as in Shared drives).
- Delete sends a folder and its contents to trash, as in Drive. Restoring brings everything back to where it was.
- Deleting a folder that holds other people's artifacts (my call, as in Drive): the folder and the deleter's own items go to trash, and other owners' artifacts move to their owners' top level, keeping their direct shares. While a folder is in trash, nobody gets access through it. If an item's original parent is gone when it's restored, it goes to its owner's top level (or the space's top level on hosted).
- Moving between spaces (hosted, my call, following the existing move rules): a folder can move to another shared space with everything inside it. That takes manager in the source and editor or manager in the target, as an artifact move does. The same access warning lists everyone who gains or loses access across all the contents. A move is all or nothing.

### Sharing (as in Drive)

- A folder can be shared with people (viewer or editor) and, where the install supports it, with the team or by public link, the same choices as an artifact.
- Access flows down: anyone with access to a folder has at least that access to everything inside it, at any depth, including things added later.
- Access only adds. A person's access to an artifact is the highest of: their direct share on it, any folder above it, and (hosted) their space role.
- Moving an artifact or folder into a shared folder shows a Drive-style warning that names who gains access. Moving out shows who loses the access they had through the old folder. Direct shares on the moved item stay.
- Public links and team visibility on a folder follow the same rules, and hosted space rules still cap them (a space with public links off can't have a public folder).
- **What folder editors can do (owner decision: Drive's rights, plus the switch).** Editors of a folder can add, move and remove items, create subfolders, edit everything inside, share the folder and its items, change their visibility, and trash items, including items other people own. Inherited editor access includes live-data writes. The folder's owner (or a space manager on hosted) can turn on "Editors can't share". With it on, only the owner (or managers) can share or change visibility. This is a change from today, where only an artifact's owner can share it, change visibility or delete it. Within folders, Drive's rules apply.
- **Hosted cap (my call):** a folder in a shared space can be shared only with people who can already be given access there under that space's rules. Outside sharing is still off until M4, so folder sharing opens no new way into a space. A Personal space's folders follow the same guest rules as artifacts. The red-line suite gets cases for both.

### Tags

- Free-text labels, many per artifact. Tags are shared: everyone who can see an artifact sees its tags.
- Tags never grant access. Seeing a tag list shows only artifacts you can already see.
- People who can edit an artifact can add or remove its tags.
- Tags are per install (self-hosted) or per space (hosted), so a tag name means the same thing to everyone in that place. My call: case-insensitive, shown as first typed.
- Tag names can leak on their own ("layoffs"), so (my call) the tag list a person sees includes only tags on at least one artifact they can see. A tag with nothing visible to you doesn't exist for you.
- Renaming, merging or deleting a tag across the install or space is for the instance owner and admins (self-hosted) or space managers (hosted), my call. Anyone who can edit an artifact can still add or remove tags on it.

### Agents

- MCP publish and update accept a destination folder (by id or by path such as `open-artifacts/hosted/specs`) and tags.
- When an agent doesn't name a folder, the instruction to agents is: pick the best existing folder from context (the repo or project it's working in, the conversation, and where similar artifacts already live), and create one if nothing fits. If it can't guess, it uses the top level.
- New MCP tools let agents list folders, create a folder, move an artifact, and set tags.
- **Ask first (owner decision).** Any agent action that would change who can see something must be confirmed by the person before it happens. That covers publishing into a shared folder, moving into or out of one, and sharing a folder. The tool first returns a preview (who gains or loses access) and a short-lived confirmation token. The agent shows the preview, gets the person's yes, then calls again with the token. Without the token, nothing changes. Filing into a folder only the person can see needs no confirmation.
- **Scope of ask first (owner decision): folder actions only.** The existing `share_artifact`, `unshare_artifact` and `set_visibility` tools keep working in one call, as today: a direct share is an explicit request from the person. The token makes sure the agent sees the preview; it doesn't prove the person said yes (that would need an approval click in the dashboard, which is out of scope).
- The agent-facing docs (llms.txt, the skill) describe the filing rule.

### Sorting the backlog

- When this ships, an agent proposes a folder tree and tags for the existing artifacts. Scope (my call): each person sorts only artifacts they own, using their own agent. Artifacts shared with them aren't included, and nobody sorts another user's library. On hosted, a space manager can run the same flow for a shared space.
- The proposal is shown to the owner as a page (proposed tree, what goes where, and any sharing that would change) before anything moves. The owner approves it, edits it, or rejects it.
- Nothing is shared more widely as a side effect: the proposal keeps every artifact's current access unless the owner approves a change.

## UI (Design gives options; the owner picks)

- Sidebar: the folder tree under the library (self-hosted) or under each space (hosted), like Drive's left rail.
- Folder view: breadcrumb, then folders first, then artifacts, with tags shown on each row.
- Move: a Drive-style picker plus drag and drop, with the access warning.
- Tags: a tag list in the sidebar; clicking a tag shows everything with it across folders.
- Search can filter by folder and by tag.

## Constraints

- The contract (packages/shared) gets the new shapes and routes first; the server and dashboard follow it.
- Access checks go through the same decision code as everything else (decide/orgCan on hosted). Folder inheritance must be tested in the cross-tenant red-line suite on hosted.
- Self-hosted upgrades keep working: existing artifacts land at the top level, and nothing changes until someone creates a folder or runs the sort.
- Copy: no em dashes; say "any AI agent".

## Left to the builder

- Storage shape for the tree (adjacency list or closure table) and how inherited access is resolved efficiently.
- Exact limits (depth, folders per library, tags per artifact), within reason.
- How the sort agent is run (an MCP-driven flow from the owner's own agent is the expected default).
