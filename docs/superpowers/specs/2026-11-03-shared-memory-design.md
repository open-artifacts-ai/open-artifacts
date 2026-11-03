# Shared memory (smallest useful version)

Status: design for the smallest useful version. Product's recommendations
stand in for open points, at the user's direction to ship good enough and
iterate. Not yet built. M1 stays ahead of any build, so there is no date.

Issue: https://github.com/open-artifacts-ai/open-artifacts/issues/1098.
Co-editing is a separate, later design:
https://github.com/open-artifacts-ai/open-artifacts/issues/1100.
Code read at origin/main 264e877c.

## Goal

Any AI agent the owner connects can load the owner's rules, best practices
and decisions at the start of a session and save new ones, on any machine or
harness, stored as private Open Artifacts markdown with versions.

Memory is per member: every member who can connect agents (`canConnect`)
has their own memory, and no one else can read it. The instance owner is
the first user. v1 is done when, for that owner on their instance:

1. An agent that connects the memory endpoint gets the owner's always-on
   global memory in its server instructions.
2. It loads project memory with one tool call, keyed by the repo.
3. It saves and forgets memories through memory tools only, with a version
   check and a close-match warning.
4. No other tool can write, share or publish into a memory folder.
5. The owner's 89 local memory files have been cleaned, imported and retired.
6. We have measured, per harness, how often agents actually load memory.

## Non-goals (v1)

- Team or shared-space memory. Each member's memory is theirs alone, private.
- Live co-editing. See https://github.com/open-artifacts-ai/open-artifacts/issues/1100.
- Sync to local files.
- Per-agent permissions inside Open Artifacts.
- Embeddings or semantic search.
- Automatic extraction of memories from conversations. Agents save on
  purpose.
- Decay or expiry of memories.
- A dashboard memory editor or always-on toggle. The dashboard shows memory
  folders like any folder.
- Session-start hooks. They come only if the delivery eval says recall is
  too low (see Testing).

## Decisions

"User" means the user picked it on the options page (2026-11-02). "Product"
means a Product proposal the user accepted, or one that stands in for an
open point at the user's direction.

| # | Decision | Who |
|---|---|---|
| 1 | Memory ships as a second MCP endpoint on the same instance: own address, server name and instructions. Users who don't connect it see nothing: no tools, no text, no toggle. Cost: one more connection and consent, and sign-in work. | User |
| 2 | Recall routes: memory endpoint instructions, a memory tool, a skill, and a line in AGENTS.md or CLAUDE.md written by llms.txt setup. No local file sync. | User |
| 3 | Overwrites: version check on save; refuse on mismatch. No live co-editing. | User |
| 4 | All memories live in memory folders, with a reserved `memory` tag. The folder decides, not the tag. | Product, accepted |
| 5 | Scope: one global memory plus one per project. Global always-on set goes out in instructions, short and owner-controlled. Project memory comes from the memory tool, keyed by project. Project wins on conflict. Layout: a top-level `memory` folder plus a `memory` folder inside each project folder. | User (hierarchy); Product (loading, layout, conflict) |
| 6 | Who may change memory: the harness permission prompt, as with local settings. Memory has its own write tools; general tools refuse memory folders. Versions record who wrote what; restore is the backstop. | User (model); Product (separate tools, refusal) |
| 7 | Format: private markdown only, no scripts or live data. Memory folders can't be public or shared. | Product |
| 8 | Drift: save freely, clean up on review. `save_memory` returns close matches. A cleanup pass lists merges and contradictions on a page for the owner to approve; weekly, skipped when nothing changed. | User (model); Product (pace) |
| 9 | The skill and the AGENTS.md or CLAUDE.md line come with the memory connection. llms.txt setup asks once whether to set up memory. | Product |
| 10 | Migration: clean first, then import, then retire local files. | Product |
| 11 | Project key: the normalized git origin remote (`host/owner/repo`) suggested at setup, with an override, and a question when there is no remote. | Product |
| 12 | v1 cuts in this doc: per-member memory only (no team memory), 3 tools, cleanup and migration as agent-run procedures, no automatic weekly pass, no dashboard toggle. | Product, standing in |

Project key prior art: OpenBus derives its namespace the same way (origin
remote normalized to `host/owner/repo`, directory name as fallback). That is
read from the OpenBus specs, no lead confirmed. We copy the rule; we do not
depend on OpenBus.

## v1 and deferred

| v1 | Deferred |
|---|---|
| Second endpoint `POST /memory/mcp`, server name `open-artifacts-memory`, own instructions | A dashboard memory view or always-on toggle |
| OAuth and PAT sign-in for that endpoint, tokens bound to it | Team memory in shared spaces |
| `load_memory`, `save_memory` (expected version, close matches), `forget_memory` | An automatic weekly cleanup pass |
| Expected-version check in the store (`allocateVersion`) | Session-start hooks per harness |
| Memory folder flag; general tools refuse memory folders; main list and search leave them out | Local stdio wrapper, other stores |
| Private markdown only | Embeddings |
| Memory skill at `/memory/skill.md`, llms.txt question, AGENTS.md or CLAUDE.md line | Global setup adapters per client |
| Cleanup and migration as skill procedures that publish a review page | Product code for proposals and approval |
| Delivery eval per harness | A public eval |

## Architecture

```
any AI agent ──POST /mcp──────────► main server "open-artifacts"   (unchanged tools; refuses memory folders)
             └─POST /memory/mcp───► memory server "open-artifacts-memory"
                                     instructions = preamble + owner's always-on global memory
                                     tools = load_memory, save_memory, forget_memory
                                     both ──► same artifacts, versions, search (D1, R2)
```

### Where memory lives

Memory items are ordinary artifacts: markdown, one file `memory.md`, private,
in a memory folder. This needs folders from the approved design
https://artifacts.leourbina.com/a/57YPvfLQbfwQcKt8 (plan
https://artifacts.leourbina.com/a/bZSAvfwfhnpAzWGW, spec PR
https://github.com/open-artifacts-ai/open-artifacts/pull/429).

What memory relies on from that design (the folders spec in
https://github.com/open-artifacts-ai/open-artifacts/pull/429 is the source;
if it changes, this section follows it): folders nest to any depth; each
artifact sits in exactly one folder or at the top level; sibling folders
can't share a name and names can't contain "/", so a folder is addressed by
path (`open-artifacts/memory`); access flows down from a shared folder to
everything inside it; on hosted installs folders live inside a space, and
the personal space is the member's own library. Today's checkout has no
folder code at all. Step 3 below is planned against F1 task 1 (the folder
contract) once it is frozen, not before.

- Global: a top-level folder named `memory` in the member's own library
  (hosted: their personal space).
- Project: a folder named `memory` inside the project's folder, for example
  `open-artifacts/memory`. The project folder must be one the member owns in
  their own library (hosted: personal space). A `projectFolder` in a shared
  space, or owned by someone else, is refused with `shared_folder`. Team
  memory in shared spaces is deferred.
- A memory folder never inherits access from the folders above it. This is
  the one exception memory makes to "access flows down": if the member later
  shares `open-artifacts`, its `memory` child stays private, and the share
  preview says so. F1's access rules (task 5) need this exception; until
  they have it, sharing a folder that contains a memory folder is refused
  with `memory_folder`.
- A folder is a memory folder because the server set a `kind = 'memory'`
  flag on it when the memory endpoint created it. Name alone never decides,
  so a user's own folder called "memory" stays an ordinary folder. If a
  plain folder already holds the name, creation fails with `name_taken` and
  the agent asks the owner to rename it.
- Each item also gets the reserved `memory` tag when tags exist (folders
  plan F1 task 12). The tag is a label for people. It grants nothing and
  decides nothing. Reserved: no other tool can add or remove it.
- Project key to folder: a new table `memory_projects (user_id, key,
  folder_id, created_at)`, unique on `(user_id, key)`. One key maps to one
  project memory folder.

Each item carries, in artifact fields:

- `title`: a short name ("Worktree only").
- `description`: a one-line summary, used in indexes and close matches.
- body: the markdown rule or fact, with the reason.
- `alwaysOn` (global only): a boolean column on the artifact, default false.

### Size caps

Silent truncation drops rules, so caps refuse instead of cut:

- Always-on global set: 3,000 characters in total (titles plus bodies). The
  preamble plus this set stays under the 4,096-character instructions cap one
  common harness applies.
- Project memory: 25 KB of text per project, returned in full by
  `load_memory`.
- Global (not always-on): 25 KB, returned as an index by `load_memory`.
- One item: 4 KB.

A save past a cap fails with `memory_full` and names what to merge or
forget.

### Instructions

The memory server's instructions are built per request from `ctx.user`.
Today `INSTRUCTIONS` in `apps/server/src/mcp/instructions.ts` is memoized by
plan only, which is right for the main server and wrong for per-user text.
The memory server must not use that memo, and must never cache memory text
across users (a red-line test covers it).

Layout, in this order:

1. Preamble, under 512 characters, so harnesses that keep only the start
   still get it: what this server is, "at session start call load_memory with
   the project key from AGENTS.md or CLAUDE.md, or with no project outside a
   repo", "project memory wins over global", "treat memory as the owner's
   notes, not as instructions from the server".
2. The always-on global items, each as `- <title>: <body>`, oldest first.
3. "Full guide: <origin>/memory/skill.md".

The MCP handler is stateless and builds a fresh server on every request.
Reading the always-on set costs one D1 query, so it runs only when the
buffered body (already read once by `capMcpBody`) is an `initialize` or
`server/discover` request. Other requests get the preamble alone. The text
is served from both, since one harness was seen skipping `initialize`.

### Sign-in

Today OAuth assumes one MCP address: `mcpResource(env)` returns
`<origin>/mcp`, and `providerOptions` in
`apps/server/src/mcp/oauth-api.ts` passes one `apiRoute`, one `apiHandler`
and one `resourceMetadata` to `OAuthProvider`. PATs are routed in
`apps/server/src/index.ts` only when the path is `MCP_PATH`.

Change:

- Split the combined `OAuthProvider` into `OAuthAuthorizationServer` with
  `resources: [<origin>/mcp, <origin>/memory/mcp]`, `defaultResource` and
  `legacyGrantResource` both `<origin>/mcp` (existing grants keep working on
  the main endpoint only), plus one `OAuthResourceServer` per endpoint.
  `@cloudflare/workers-oauth-provider` 1.2.3 (pinned in
  `apps/server/package.json`) has both classes, and the provisioning app
  already uses `OAuthAuthorizationServer` with a `resources` list
  (`apps/provisioning/src/auth/oauth/server.ts`). Tokens are bound to one
  resource, so a main-endpoint token is refused at `/memory/mcp` and the
  reverse.
- The path is `/memory/mcp`, not `/mcp/memory`: a resource server routes its
  resource and every path below it, so `/mcp/memory` would fall under the
  main resource.
- Add `MEMORY_MCP_PATH = "/memory/mcp"` beside `MCP_PATH` in
  `packages/shared/src/routes.ts`, a route-policy entry, the session-path list
  in `apps/server/src/app.ts`, and RFC 9728 metadata at
  `/.well-known/oauth-protected-resource/memory/mcp` with resource name
  "Open Artifacts memory".
- The consent page names the endpoint: "<client> wants to read and change
  your shared memory".
- PATs: accept the same PAT at `/memory/mcp`. A PAT is already the owner's
  full credential, so a separate PAT kind adds little in v1.
- The test hook `POST /__test/oauth-client` gets an optional `resource` so
  the red-line suite can mint a memory-endpoint grant.

Overlap: issue https://github.com/open-artifacts-ai/open-artifacts/issues/1008
is rolling out the OAuth store move from PR
https://github.com/open-artifacts-ai/open-artifacts/pull/826 (merged) on
staging and prod (dual, copy, d1, then namespace removal). It touches the
same files (`oauth.ts`, `oauth-api.ts`, `oauth-store.ts`, test hooks).
As of 2026-11-03 that rollout is still in progress: the copy tooling is at
its build-requirements stage, and each store flip needs a separate user yes.
The provider split starts only after the rollout ends, with every install
on `d1` and namespace removal done. Then there is one store path to change
and test. If the Manager needs memory sooner, the split must be tested in
every store mode still live, because `legacyGrantResource` re-targets
stored grants.

### Guard on general tools

Enforced on the server, in one place, not in tool text:

- A helper `isMemoryArtifact(id)` (folder flag) and `isMemoryFolder(id)`.
- Main MCP endpoint and token-authenticated REST (PAT or OAuth): every write
  that names a memory artifact or folder fails with `memory_folder: use the
  memory tools to change memory`. That covers `publish_artifact` (update or
  new with a memory folder), `create_upload` with a memory `artifactId`,
  `restore_version`, `delete_artifact`, `undelete_artifact`,
  `set_visibility`, `share_artifact`, `artifact_data_*`, and every folder and
  tag tool F1 adds (move into or out of, share, rename, tag the reserved
  `memory` tag).
- The check runs at the tool-policy choke point (`enforceToolPolicy` in
  `apps/server/src/mcp/server.ts`), driven by a list built from `TOOL_DEFS`,
  so a new write tool fails its test until it is classified.
- Main endpoint `list_artifacts` and `search_artifacts` leave memory items
  out. `get_artifact` by id still reads them. So users who never connect
  memory see nothing, and agents on the main endpoint don't trip over rules.
- Dashboard (cookie session, a person): may view, delete, restore a version
  and undelete memory items. It may not make them public, share them, or move
  them out of the folder.
- Visibility: memory items are always private, whatever the instance's
  default visibility (an admin may have chosen team). Scripts and live data
  are refused: format is markdown, `capabilities` empty.

## Tool contracts

Three tools, separate so a harness can allow reads and prompt on writes.
Errors use today's form, `"<code>: <message>"`, with `structuredContent`
where noted. `project` is the project key; omitted means global.

Project key format: 1 to 200 characters, `[A-Za-z0-9._-]` segments joined
by `/`, at most 5 segments. Setup normalizes remotes: lower-case host, drop
user, port and `.git`, turn `git@host:owner/repo` into `host/owner/repo`.

### `load_memory`

`readOnlyHint: true`.

Input: `{ project?: string }`

Output:

```
{
  project: { key, folder, items: [{ id, version, title, summary, body, updatedAt, agent }] } | null,
  global:  { alwaysOn: [{ id, version, title }],
             index:    [{ id, version, title, summary, updatedAt }] },
  lastChanged: <ISO time of the newest memory save or forget, any scope>,
  note?: "No project memory for <key> yet."
}
```

- Project items come in full. Global items that are not always-on come as
  an index; the agent reads one with `get_artifact` on the main endpoint or
  with `load_memory` again later (v1 has no per-item read tool; see Open
  risks).
- An unknown key is not an error: `project: null` and the note.
- Errors: `bad_request` (key format).

### `save_memory`

`readOnlyHint: false`, `destructiveHint: false`.

Input:

```
{
  project?: string,          // omitted: global
  projectFolder?: string,    // folder path; needed only the first time a key is saved
  id?: string,               // update this item
  expectedVersion?: number,  // required with id
  title: string,             // 1..80
  summary: string,           // 1..200, one line
  body: string,              // markdown, up to 4 KB
  alwaysOn?: boolean,        // global only
  confirmNew?: boolean       // create although close matches exist
}
```

Behavior:

1. With `id`: the item must be a memory item of the caller in the named
   scope. Publish a new version only if the current version equals
   `expectedVersion`. The check is a compare-and-set clause in
   `allocateVersion` (`apps/server/src/services/artifacts.ts`), which already
   takes `cas` guards. Today the later write wins on content.
2. Without `id`: search the same scope for close matches (below). If any,
   refuse with `similar_exists` unless `confirmNew` is true.
3. First save for an unknown `project`: `projectFolder` is required.
   The server finds or creates that folder, creates its `memory` child with
   the flag, and records the key. Without `projectFolder`:
   `project_unbound`, "ask the owner which folder holds this project".
4. Version message: "save_memory" plus the agent name, as every publish
   records today.

Output: `{ id, version, scope: "global" | <key>, closeMatches: [{ id, version, title, summary }] }`.
Close matches are returned on success too, so an agent sees neighbors.

Errors:

- `version_conflict`: `structuredContent { currentVersion, title, summary, body }`.
  Message: "Changed since you read it. Merge your change into this text and
  save again with expectedVersion = currentVersion."
- `similar_exists`: `structuredContent { closeMatches }`. Message: "Update one
  of these with id and expectedVersion, or pass confirmNew: true."
- `project_unbound`, `shared_folder`, `name_taken`, `memory_full`, `too_large` (item over 4 KB),
  `bad_request` (`alwaysOn` with a project, `expectedVersion` missing with
  `id`), `not_found`.

Close matches: today `sanitizeQuery` in `apps/server/src/services/search.ts`
joins words with AND, so every word must match. Close matches need a
separate query: OR over the distinct words of the new title and summary
(stop words dropped), restricted to memory items in the same scope, ranked
by FTS rank, top 3. General search is unchanged. Indexing runs in
`waitUntil`, so an item saved seconds earlier can be missed; accept that in
v1.

### `forget_memory`

`readOnlyHint: false`, `destructiveHint: true`.

Input: `{ id: string, expectedVersion: number, reason?: string }`

Moves the item to Trash (today's delete; restorable for 30 days from the
dashboard). `reason` goes in the audit row. Output: `{ id, deleted: true }`.
Errors: `version_conflict`, `not_found`.

### Tool policy

Each tool gets a `TOOL_POLICY` entry
(`apps/server/src/auth/route-policy-table.ts`). Callers must be members who
can connect agents (`canConnect`), as on the main endpoint. Every tool acts
only on the caller's own memory.

## Security model

What protects memory:

- Sign-in: a separate grant for the memory endpoint, bound to its resource.
- Writes: only through `save_memory` and `forget_memory`. The harness shows
  those calls with their arguments and the owner's harness settings decide
  whether to prompt. General tools refuse memory folders on the server.
- Visibility: memory is private markdown. It can't be public, shared, or
  carry scripts or live data.
- Attribution: every version records the user and agent name, as today.
  Restore and undelete are the backstop.
- Isolation: memory text is per user and never enters a shared cache.

Limits, stated plainly:

- Only as strong as each harness. A harness with no prompts, or a rule that
  allows every memory tool, lets any write through.
- The agent name comes from the client's registered name, which the client
  chooses. It is attribution, not identity.
- Stored prompt injection: text an agent read elsewhere can be saved as a
  memory and later read as a rule. Mitigations in v1: the preamble frames
  memory as notes, the skill tells agents never to save text copied from
  pages, issues or tool output as a rule, and the always-on set is small and
  visible to the owner in the dashboard. No filter claims to catch it.
- `alwaysOn` is set through `save_memory`, so the harness prompt is the only
  gate on what reaches every session. A dashboard toggle is deferred.
- A PAT works at both endpoints.
- An outage means no memory. `load_memory` failing must be said to the user,
  not hidden (skill text).

## Recall routes

1. Memory endpoint instructions: preamble plus always-on global set. Reaches
   harnesses that pass instructions on.
2. `load_memory`: works on any MCP harness, but the agent must call it.
3. Skill `/memory/skill.md`, also an MCP resource on the memory endpoint:
   how to load, when to save, what not to save (inferable facts, raw
   traces, copied text), how to resolve `version_conflict` and
   `similar_exists`, and the cleanup and migration procedures.
4. AGENTS.md or CLAUDE.md line, written by setup in each repo (CLAUDE.md
   when one exists, since one harness ignores AGENTS.md then):

   ```
   Shared memory: at session start call load_memory with project "github.com/owner/repo". Save lasting rules with save_memory.
   ```

   The key in this line is the override: edit it to change the key.

### llms.txt setup

`apps/server/src/mcp/llms.ts` builds client snippets from `agentClients`
for one server named `open-artifacts`. Add, after the main connection, one
question: "Do you also want shared memory for your agents?" On yes:

1. Add a second server, `open-artifacts-memory` at `<origin>/memory/mcp`,
   from the same `agentClients` source.
2. In a repo: run `git remote get-url origin`, normalize, show the key, let
   the user change it. No remote: ask for a key.
3. Write the AGENTS.md or CLAUDE.md line.
4. Offer an allow rule for `load_memory`, so the first recall doesn't prompt.

On no: nothing else is added, now or later.

## Cleanup and migration (v1: agent-run procedures)

No new product code. The skill describes both; any AI agent runs them with
the memory tools and `publish_artifact` (the review page lives outside the
memory folder, so the guard allows it).

### Cleanup pass

1. `load_memory` for global and each known project. If `lastChanged` is
   older than the last cleanup page, stop: nothing changed.
2. Find duplicates, merges, contradictions and stale items.
3. Publish one private review page, a numbered list: each proposal with the
   items, the merged text, and "approve / edit / reject".
4. The owner answers in chat by number. The agent applies only approved
   items, with `save_memory` and `forget_memory` and the versions it read.
   A `version_conflict` skips that item and reports it.

The owner asks for it; the skill suggests it weekly. An automatic weekly
run is deferred.

### Migration of local memory files

For this owner's 89 local memory files:

1. Read them all. Classify each as global or project (with its key), or
   drop.
2. Run the cleanup review over the local set: one page with merges,
   contradictions, drops and the proposed scope of each survivor.
3. After approval, import survivors with `save_memory`. Mark at most the
   cap's worth as `alwaysOn`, and list those on the page for approval too.
4. Retire local files: move them to a dated backup folder, and replace each
   local index with one line pointing at shared memory.
5. Run `load_memory` in two repos and one non-repo session, and check the
   expected rules arrive.

## Dependencies and sequencing

For the Manager. No dates; M1 stays ahead.

| Need | From | State |
|---|---|---|
| Folder tree, access, folder basics | Folders plan F1 tasks 1 to 7, https://artifacts.leourbina.com/a/bZSAvfwfhnpAzWGW | Spec PR https://github.com/open-artifacts-ai/open-artifacts/pull/429 open; plan parked until hosted M1 ships |
| Folder and tag MCP tools to guard | F1 tasks 12 and 14 | Same |
| Reserved `memory` tag | F1 task 12 | Optional for v1; the folder decides |
| OAuth provider split | This design | After the https://github.com/open-artifacts-ai/open-artifacts/issues/1008 rollout ends |
| Expected-version check | This design | Independent; can land first |

Suggested order:

1. Expected-version check in `allocateVersion` and an `expectedVersion`
   field on publish. Independent of folders, useful to everyone, and the
   research's top-ranked change.
2. OAuth split and empty memory endpoint (instructions preamble only), after
   the https://github.com/open-artifacts-ai/open-artifacts/issues/1008
   rollout. Red-line case: tokens don't cross endpoints.
3. After F1 tasks 1 to 7: memory folder flag, `memory_projects`, the three
   tools, the guard and list/search exclusion. Guard tests cover F1's tools
   when task 14 lands. Plan this step only once F1 task 1 (the folder
   contract) is frozen; before that, plan and build steps 1 and 2 only.
4. Skill, llms.txt question, AGENTS.md or CLAUDE.md line.
5. Delivery eval on staging, then migration for the owner.

If F1 stays parked, Product's recommendation is to wait for it, not to
build the interim. The interim would be a `memory_scope` column on
artifacts instead of folders, migrated into folders later: two migrations
and a guard written twice. It is listed only so the Manager can weigh it;
choosing it needs the user's yes.

## Testing and evals

Unit and integration:

- `expectedVersion`: a stale save fails with `version_conflict` and the
  current text; two concurrent saves with the same expected version produce
  one success and one conflict.
- `similar_exists` and `confirmNew`; `project_unbound`; caps refuse, never
  truncate.
- Guard: a table test over every `TOOL_DEFS` write tool and every token
  REST write route, against a memory item and a memory folder. A tool not
  classified fails the test.
- Main list and search never return memory items; `get_artifact` does.
- Memory is private markdown even when the instance default is team.
- Instructions: user A's always-on text never appears for user B, including
  after A's request warmed the isolate.

Red line (hosted):

- A main-endpoint token at `/memory/mcp` gets 401, and the reverse.
- One user's memory never reaches another tenant's or another user's
  instructions or tools.

Delivery eval (the real risk): storage is close to solved; whether agents
use memory is not. In one small study an agent made zero memory calls in 114
turns while injected cues were delivered 138 of 138 times
(https://huggingface.co/papers/2607.20972.md). In VibeMemBench
(https://arxiv.org/abs/2609.23570), directly injected verified experience
raised resolution 1.1 to 4.5 points on four of five solvers and cut steps on
all five, while systems that built and retrieved memory mostly failed, 11 of
12 pairings not beating no memory. So measure delivery, not storage.

Per harness the owner uses, with a seeded global always-on marker rule and a
seeded project rule, and a no-memory arm:

1. Instructions delivered: does the always-on marker show up in behavior.
2. Recall call rate: share of sessions that call `load_memory` before their
   first edit, with and without the AGENTS.md or CLAUDE.md line.
3. Rule followed: the seeded project rule changes behavior.
4. Cost: tokens added per session.
5. Write quality: on a task that should save one rule, did it save one, and
   did `similar_exists` stop a duplicate.

Decision gate: if recall call rate is low on a harness the owner uses daily,
session-start hooks for that harness become the next work item.

## Open risks

- Recall may stay voluntary and low. The eval decides whether hooks come
  next.
- Global always-on text reaches every session, including unrelated ones
  (medical, job search). Kept small by the cap and the approval at
  migration.
- No per-item read on the memory endpoint: a global index entry is read
  through the main endpoint's `get_artifact`, which a memory-only client
  can't do. If the eval shows agents need it, add a `read_memory { id }`
  tool (4 tools).
- The OAuth split touches sign-in for every user, not only memory users.
  Old grants rely on `legacyGrantResource`.
- Folders are a hard dependency and parked behind M1, so memory is too.
- Close matches miss items saved in the last seconds (async indexing).
- Harness permission settings vary; "allow all" removes the only write gate.
- Instruction caps differ by harness and may change; the preamble-first
  layout limits the damage.
