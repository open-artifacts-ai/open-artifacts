# Viewer Presence Implementation Plan

> **Revised 2026-10-29** against origin/main `5469cf78`. The first version predated #503 (UserPresence revocation gate), #559 (agent labels, `stripNameControls`, `AgentAttr.via`), #591 (`KEY_OWNERS` allowlist), #709/#728/#792 (publish modes, indexing in `waitUntil`), #808 (`withCred`), #814, #816 (`gone.retryAfterMs`) and #821 (client `notBefore`). Changes: every line reference moved to today's main; join steps run only after the stale and UserPresence gates (Task 3); `KEY_OWNERS` entries and an updated `keys.test.ts` list (Task 4); `connection` from `agent.via` and the MCP 2026-07-28 rule: `Mcp-Session-Id` only for 2025-03-26 through 2025-11-25 clients at `initialize`, never minted or echoed for 2026-07-28 requests (Task 5); our names renamed to `viewer_presence_*` / `viewerPresence*` so they can't be confused with the `UserPresence` DO and its `presence_touch_failed` log (Global Constraints); a token connection's label never reaches anyone but the owner, product from `agent.name` only for a grant, with an explicit test (Task 6); ping cleanup in `gone()`/`close()` (Task 7); one stack per shown layer (Task 9).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The viewer header shows who else has the artifact open right now (signed-in people by name, anonymous viewers as "Anonymous <Animal>", AI agents in their own shape), Google Drive style.

**Architecture:** Presence rides the existing `R.events` socket to the per-artifact `ArtifactRuntime` DO. The Worker route derives an opaque per-artifact presence key and display identity and hands them to the DO in upgrade headers; the DO keeps everything in socket attachments and three small SQLite tables (no in-memory state, so hibernation is safe), and broadcasts one coalesced `presence` frame on join, leave and agent expiry. Agents have no socket: MCP and REST calls that already reach the DO record them (one added fire-and-forget DO call per agent read), keyed by a server-issued `Mcp-Session-Id` for legacy-era MCP clients (2025-03-26 through 2025-11-25) and by connection otherwise.

**Tech Stack:** Cloudflare Workers + Durable Objects (hibernating WebSockets, `setWebSocketAutoResponse`, alarms, SQLite), Hono, zod 4 (`@oa/shared`), MCP SDK v2 (`@modelcontextprotocol/server` 2.3.1) via `agents/mcp/server` (stateless; both the 2025 `initialize` era and the 2026-07-28 per-request envelope era), React 19 + TanStack + shadcn (`@oa/ui`), vitest (`@cloudflare/vitest-pool-workers` for the server), Playwright (mock and real configs).

**Spec:** `docs/superpowers/specs/2026-10-24-viewer-presence-design.md` (approved; revised 2026-10-29). Read it with this plan.

## Global Constraints

- Mirror Google Drive's patterns for every detail the spec leaves open.
- No email, no user id, no token id, no IP, no anonId in any presence frame or card. The token label goes only to the token's owner (Task 6 tests it against every other viewer class).
- Names only: a user with no name is "Member" (or "Guest" for role `guest`); initials and hue then come from the opaque per-artifact key. Never use `versionEvent`'s email fallback or `UserAvatar` (both use the email).
- Anonymous presence id: a random value in a session cookie `oa_pid` on the app origin (no `Expires`/`Max-Age`, `Path=/`, `SameSite=Lax`, `Secure` on https), never derived from or stored next to `oa.anonId`. The server treats it as opaque: `^[A-Za-z0-9_-]{16,64}$`, else ignored.
- The presence key shown to clients is per artifact (HMAC of artifact id + identity under a new `oa:viewer-presence` key), so it can't link a viewer across artifacts.
- **Naming.** The server already has a `UserPresence` DO (`apps/server/src/runtime/presence.ts`, revocation), its tests (`test/presence.test.ts`, `test/presence.class.test.ts`), `presenceStub`, `touchPresence` and the logs `presence_touch_failed`, `presence_unbound`, `presence_close_failed`, `presence_revoke_failed`. Everything this feature adds on the server is named `viewer_presence_*` / `viewerPresence*` / `viewer-presence*`:
  - SQLite tables `viewer_presence_left`, `viewer_presence_state`, `viewer_presence_agent`.
  - Key label `oa:viewer-presence`; function `viewerPresenceKey` in `apps/server/src/runtime/viewer-presence-key.ts`.
  - DO members `viewerPresenceChanged`, `flushViewerPresence`, `pendingViewerPresence`, `touchViewerAgent`; socket tag `VIEWER_PRESENCE_TAG = "~vp"`; upgrade header `X-OA-Viewer-Presence` (`VIEWER_PRESENCE_HEADER`).
  - Worker helper `apps/server/src/runtime/viewer-presence-agent.ts` (`viewerAgentTouch`, `touchViewerAgentLater`).
  - Logs `viewer_presence_touch_failed` (agent touch) and `viewer_presence_flush_failed` (if a flush can throw).
  - Server tests `test/viewer-presence.do.test.ts`, `test/viewer-presence.agents.test.ts`, `test/viewer-presence.roster.test.ts`.
  - Shared module `packages/shared/src/viewer-presence.ts` and test `packages/shared/test/viewer-presence.test.ts`. Its exported names keep the `PRESENCE_*` prefix (no collision in `@oa/shared`), and the wire frame type stays `"presence"`.
  - Dashboard names (`usePresence`, `presenceId.ts`, `viewer/presence/*`) stay as they are: nothing there collides.
- Free plan: no polling; the client pings `"ping"` every 30 s and the DO answers `"pong"` through `setWebSocketAutoResponse` (no wake); stale sockets are found from `getWebSocketAutoResponseTimestamp` in the existing alarm; no per-socket timers; frames only on join, leave and agent expiry, coalesced.
- Timings (shared constants, `packages/shared/src/viewer-presence.ts`): `PRESENCE_PING_MS = 30_000`, `PRESENCE_STALE_MS = 60_000`, `PRESENCE_SWEEP_MS = 30_000`, `PRESENCE_GRACE_MS = 5_000`, `PRESENCE_COALESCE_MS = 1_000`, `AGENT_PRESENT_MS = 120_000`.
- Caps: display name 80 chars, activity 80 chars, roster at most `PRESENCE_LIST_MAX = 100` entries plus a `total`.
- No em dashes in user-facing copy; say "any AI agent" where relevant.
- Every change to an existing shared shape is optional and appended last (older clients parse; `json-shapes.snapshot.test.ts` stays byte-identical), and is recorded in `packages/shared/HOSTED_CONTRACT.md`.
- Design picks (spec Section 8; https://artifacts.leourbina.com/a/MkqMepcHeLvbGvKL): **1A** agents are a rounded square (7px radius at 28px, 10px at 40px) with the owner's initials and a color per session; people and anonymous viewers are circles. **2A** faces go first in the TitleBar right group, before the version chip, side by side with a 4px gap and no overlap; show 3 then "+N", or all 4 when exactly 4; phones show one face plus "+N". **3A** the agent card is plain lines: name, "<Owner>'s agent · Viewing|Editing", the note in quotes, captioned "In the agent's own words". **4A** white line-icon animals (Lucide style: 24px grid, 2px stroke, round caps) on one 9-color palette for both themes: Teal `#1f6f5a`, Violet `#5b48b8`, Rust `#b04a14`, Blue `#2456c4`, Berry `#a3305f`, Olive `#4d6b12`, Umber `#8a4d0f`, Sea `#0e6e8c`, Plum `#7a3f99` (white glyph at least 5.4:1). Faces are 28px with a 2px ring in the surface color; card faces 40px.
- Never `git stash`; commit WIP at checkpoints.

## Review Focus

1. **Old cached dashboards that never ping.** A tab running the previous SPA must not be swept as stale every 60 s (a reconnect loop). Only sockets that opened with `?ping=1` are swept; others leave on close or at the socket TTL. Test in Task 3.
2. **DO hibernation between join and leave.** Roster, grace and agent rows must come back from attachments and SQLite alone after eviction. Test in Task 3 (fresh `ArtifactRuntime` instance on the same storage).
3. **Laptop sleep or network loss (no close frame).** The face is gone within `PRESENCE_STALE_MS + PRESENCE_SWEEP_MS` (about 90 s worst case; spec: "within about 90 seconds"). Test in Task 3 with the clock override.
4. **Hostile anonymous cookie.** Oversized, malformed or rotating `oa_pid` values can't break the roster or exhaust animals: malformed means a per-socket identity, and the existing 3-per-/56 anonymous socket cap bounds the faces. Test in Task 4.
5. **Hostile or odd names.** A 500-char name, HTML, RTL or emoji renders as plain text, capped at 80 chars; an anonymous viewer can never claim a name. Tests in Tasks 2 and 9.
6. **Refused sockets never appear.** A socket refused after `acceptWebSocket` (stale authorization or a failed `UserPresence.touch`) never joins the roster and never leaves a grace row. Test in Task 3.
7. **Token labels stay with the owner.** A PAT connection's label never reaches a named, anonymous, guest or embed socket. Test in Task 6.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/shared/src/viewer-presence.ts` (new) | Presence schemas, frame, constants, animal list, palette size, cookie name, `AgentTouch` |
| `packages/shared/src/schemas.ts` | `ArtifactEventSchema` gains `presence`; `hello.you?`; `activity?` on get/data tool inputs |
| `packages/shared/src/mocks/events.ts` | `emitPresence` for dashboard tests and mock e2e |
| `packages/shared/HOSTED_CONTRACT.md` | New "Presence (both tiers)" section + CHANGED rows |
| `apps/server/src/runtime/roster.ts` (new) | Pure roster building: dedupe, order, animals, colors, agent names |
| `apps/server/src/runtime/do.ts` | Presence sockets, grace, sweep, coalesced broadcast, agent rows |
| `apps/server/src/runtime/routes.ts` | Events route: presence headers, cookie, `ping` |
| `apps/server/src/runtime/viewer-presence-key.ts` (new) | `viewerPresenceKey` |
| `apps/server/src/auth/keys.ts` | `oa:viewer-presence`, `oa:mcp-session` in `KEY_OWNERS` |
| `apps/server/src/mcp/session.ts` (new) | Era check; issue and verify `Mcp-Session-Id` (legacy era only) |
| `apps/server/src/runtime/viewer-presence-agent.ts` (new) | Worker-side `viewerAgentTouch(...)` builder and fire-and-forget helper |
| `apps/server/src/mcp/server.ts`, `index.ts`, `mcp/oauth.ts`, `mcp/tools/*.ts`, `mcp/instructions.ts`, `routes/artifacts.ts`, `services/artifacts.ts` | Agent session and touches |
| `apps/dashboard/src/viewer/presenceId.ts` (new) | The `oa_pid` cookie |
| `apps/dashboard/src/viewer/liveEvents.ts` | Ping, `ping=1`, presence frames |
| `apps/dashboard/src/viewer/usePresence.ts` (new) | Roster state minus self |
| `apps/dashboard/src/viewer/presence/animals.tsx` (new) | `AnimalIcon`: Lucide icons plus the 45 drawn ones |
| `apps/dashboard/src/viewer/presence/*` (new) | `PresenceStack`, `PresenceAvatar`, `PresenceCard`, palette |
| `apps/dashboard/src/viewer/TitleBar.tsx`, `FullScreenEscape.tsx`, `Shell.tsx` | Placement |

---

### Task 1: Shared presence contract

**Files:**
- Create: `packages/shared/src/viewer-presence.ts`
- Modify: `packages/shared/src/index.ts` (export), `packages/shared/src/schemas.ts:927-956` (`ArtifactEventSchema` and its doc comment), `:1013-1018` (`GetArtifactInputSchema`), `:1080-1118` (the six `ArtifactData*InputSchema`, all `z.strictObject`), `packages/shared/src/mocks/events.ts`, `packages/shared/HOSTED_CONTRACT.md`
- Test: `packages/shared/test/viewer-presence.test.ts` (new), `packages/shared/test/events.mock.test.ts`

**Interfaces:**
- Produces:
  - Constants listed in Global Constraints, plus `PRESENCE_COOKIE = "oa_pid"`, `PRESENCE_ID_RE = /^[A-Za-z0-9_-]{16,64}$/`, `PRESENCE_PING = "ping"`, `PRESENCE_PONG = "pong"`, `PRESENCE_PALETTE_SIZE = 9`, `PRESENCE_NAME_MAX = 80`, `PRESENCE_ACTIVITY_MAX = 80`, `PRESENCE_LIST_MAX = 100`, `PRESENCE_KEY_RE = /^[A-Za-z0-9_-]{16}$/`.
  - `ANIMALS: readonly { id: AnimalId; name: string; lucide: boolean }[]`: 58 family-friendly animals, ids kebab-case, names Title Case: exactly the 13 with an animal icon in `lucide-react` 1.59.0, `lucide: true`: `bird`, `bug`, `cat`, `dog`, `fish`, `panda`, `rabbit`, `rat`, `shrimp`, `snail`, `squirrel`, `turtle`, `worm` (`MouseIcon` is the computer mouse, so no `mouse` from Lucide); plus 45 more to draw (include Duck, Capybara, Axolotl, Llama). `AnimalId` is the union of ids.
  - `PresenceEntrySchema = z.object({ key, kind: z.enum(["person","anon","agent"]), name: z.string().max(80), named: z.boolean(), color: z.number().int().min(0).max(8), animal: z.string().optional(), agent: z.object({ owner: z.string().max(80), product: z.string().max(80).optional(), label: z.string().max(80).optional(), state: z.enum(["viewing","editing"]), activity: z.string().max(80).optional() }).optional() })`. `named: false` means the name is a placeholder ("Member", "Guest", "Anonymous Duck", "Agent").
  - `PresenceFrameSchema = z.object({ type: z.literal("presence"), viewers: z.array(PresenceEntrySchema).max(100), total: z.number().int().min(0) })`, most recent arrival first.
  - `AgentTouch = { key: string; product: string | null; owner: string; ownerActor: string; label: string | null; write: boolean; activity: string | null }` (server-internal RPC arg; `ownerActor` is `u:{id}`, never sent to clients).
  - `ArtifactEventSchema` gains the presence frame, appended after `gone` (which now carries `retryAfterMs?`, #816); `hello` gains `you: PresenceKey.optional()` appended last.
  - `GetArtifactInputSchema` and each `ArtifactData*InputSchema` gain `activity: z.string().max(80).optional()` appended last.
  - Mock: `ArtifactEventsMock.emitPresence(id: string, viewers: PresenceEntry[], you?: string): number`; hello carries `you` when set via `mock.presenceYou?.(id)`.

- [ ] **Step 1: Write the failing tests** in `packages/shared/test/viewer-presence.test.ts`:
  - `ANIMALS has 50 to 70 unique ids and names` (`new Set(ids).size === ANIMALS.length`, length in [50, 70], names match `/^[A-Z][A-Za-z ]+$/`).
  - `exactly the 13 Lucide animals are lucide: true` (the list above, in any order).
  - `presence frame parses through ArtifactEventSchema` (a frame with one entry of each kind).
  - `presence entry has no email, id or anonId field` (`PresenceEntrySchema.strict()` style check: parse an object with `email` and assert it is stripped; assert `Object.keys(PresenceEntrySchema.shape)` equals `["key","kind","name","named","color","animal","agent"]`).
  - `names over 80 chars are refused` and `activity over 80 is refused on GetArtifactInputSchema`.
  - `an old-shape hello (no you) still parses`; `a gone frame with retryAfterMs still parses`.
  - In `events.mock.test.ts`: `emitPresence sends one presence frame to each open socket`.
- [ ] **Step 2: Run** `pnpm --filter @oa/shared exec vitest run test/viewer-presence.test.ts test/events.mock.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `packages/shared/src/viewer-presence.ts` and the schema/mock changes above. `schemas.ts` imports from `viewer-presence.ts` (not the reverse).
- [ ] **Step 4: Record the contract** in `HOSTED_CONTRACT.md`: a "Presence (both tiers)" section (frame, entry fields and trust levels, cookie, ping/pong, timings, `?ping=1` query on `R.events`, the MCP session rule from Task 5) and CHANGED rows for `ArtifactEvent.hello` (`you?`), `ArtifactEventSchema` (`presence`), `GetArtifactInput` and `ArtifactData*Input` (`activity?`). Update the `ArtifactEventSchema` doc comment in `schemas.ts:927-941`: add `presence` to the frames list; keep the `retryAfterMs` paragraph; client messages: only `"ping"` is allowed, any other client message still closes the socket with 1008.
- [ ] **Step 5: Run** `pnpm --filter @oa/shared test && pnpm --filter @oa/shared typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(shared): viewer presence contract`.

### Task 2: Pure roster builder

**Files:**
- Create: `apps/server/src/runtime/roster.ts`
- Test: `apps/server/test/viewer-presence.roster.test.ts`

**Interfaces:**
- Consumes: Task 1 `PresenceEntry`, `ANIMALS`, `PRESENCE_PALETTE_SIZE`, `PRESENCE_LIST_MAX`; `stripNameControls` from `@oa/shared` (`schemas.ts:466`, #559).
- Produces:
  - `type PresenceIdentity = { key: string; kind: "person" | "anon"; name: string | null; guest: boolean }` (what the route passes; `name` null for anon or nameless).
  - `type SeatRow = { key: string; kind: "person" | "anon"; name: string | null; guest: boolean; since: number }` (one per live socket or grace row).
  - `type AgentRow = { key: string; product: string | null; owner: string; ownerActor: string; label: string | null; since: number; seen: number; lastWrite: number | null; activity: string | null }`.
  - `buildRoster(seats: SeatRow[], agents: AgentRow[], now: number): { viewers: PresenceEntry[]; total: number; labels: Map<string, Map<string, string>> }` where `labels` is ownerActor → (agent key → owner-only label), for owner-only variants.
  - `colorOf(key: string): number` (stable hash mod 9; an agent's key is per session, so each session gets its own color), `cleanName(s: string | null): string | null` = `stripNameControls` (C0, DEL, bidi controls, zero-width), then trim, collapse whitespace, cut to 80 code points; empty gives null. No second control-character regex.

- [ ] **Step 1: Write the failing tests** (`viewer-presence.roster.test.ts`):
  - `two seats with one key show once, at the earliest since`.
  - `most recent arrival first across people, anon and agents`.
  - `nameless person is "Member", nameless guest is "Guest", named: false`.
  - `anon names are "Anonymous " + animal; two anons never share an animal` (force a hash clash by picking two keys with the same `hash % ANIMALS.length`).
  - `animal assignment is stable for the earlier arrival when a later one joins`.
  - `ANIMALS.length + 1 anons: the last gets a numbered name ("Anonymous Duck 2")`.
  - `agents: same product gets "-2", "-3" in arrival order ("Claude Code", "Claude Code-2")`; `no product names it "Agent"`.
  - `agent state is "editing" when lastWrite is within AGENT_PRESENT_MS, else "viewing"`; `agents seen more than AGENT_PRESENT_MS ago are dropped`.
  - `an owner-only label is never in viewers, only in labels for the ownerActor`.
  - `cleanName cuts a 500-char name to 80 and strips U+202E and U+200B`.
  - `roster over 100 is cut to 100 with total = full count`.
  - `JSON of the roster never contains ownerActor or "u:"`.
- [ ] **Step 2: Run** `pnpm --filter @oa/server gen && pnpm --filter @oa/server exec vitest run test/viewer-presence.roster.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `roster.ts`. Animal pick: preferred index `hash(key) % ANIMALS.length`, then the next free index, assigned in arrival order (oldest first) so earlier arrivals keep theirs; when all are taken, cycle with " 2", " 3". Use one small non-crypto hash (FNV-1a 32) for both color and animal.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): presence roster builder`.

### Task 3: Presence on the ArtifactRuntime events sockets

**Files:**
- Modify: `apps/server/src/runtime/do.ts` (SCHEMA `:354-381`, `SocketMeta :391`, tags `:393-412`, `class ArtifactRuntime :434` (no constructor today), `fetch :1174-1293` (accept `:1245-1249`, stale and UserPresence gates `:1250-1289`, hello `:1291`), `armAt :1338-1341`, `alarm :1532-1586` (early return `:1539`), `webSocketMessage`/`webSocketClose :1698-1712`, `closeSockets :1724-1749`, `closeActor :1757-1774`, `destroy :1777-1789`, `RpcMethods :1791-1812`)
- Test: `apps/server/test/viewer-presence.do.test.ts` (new)

**Interfaces:**
- Consumes: Task 2 `buildRoster`, `SeatRow`; Task 1 constants and `PRESENCE_PING/PONG`.
- Produces (used by Task 4):
  - Upgrade headers from the route: `VIEWER_PRESENCE_HEADER = "X-OA-Viewer-Presence"` (JSON `PresenceIdentity`, absent = this socket is not counted and gets no presence frames, e.g. embeds), `EVENTS_PING_HEADER = "X-OA-Ping"` (`"1"` = this client pings).
  - `SocketMeta = { t: number; named?: boolean; p?: SeatRow & { ping: boolean; actor: string } }` (`actor` is the socket's `X-OA-Actor`, server-only, for revocation).
  - Tag `VIEWER_PRESENCE_TAG = "~vp"` on counted sockets (pushed at accept; membership is decided by `p`, see Step 3).
  - SQLite tables: `viewer_presence_left (key text primary key, kind, name, guest, since, until, actor)`, `viewer_presence_state (id = 1, hash text, sent_at integer)`. (`viewer_presence_agent` comes in Task 6.)
  - `private viewerPresenceChanged(): Promise<void>` (coalesced flush), `private flushViewerPresence(): void`, `pendingViewerPresence(): { left: number; sentAt: number | null }` (tests).
  - `hello` frame carries `you` (the socket's key) when counted.

- [ ] **Step 1: Write the failing tests** (`viewer-presence.do.test.ts`, via `runtimeStub(env, id).fetch("https://runtime.invalid/events", { headers })` and `runInDurableObject` with `instance.now` overridden, as in `events.test.ts` / `runtime.do.test.ts`). Since #503, `fetch` returns 400 "Missing authorization time" for a `u:` actor without `X-OA-Authz-At` and awaits `UserPresence.touch` (bound in `wrangler.test.jsonc`), so every direct upgrade sends `X-OA-Actor`, `X-OA-Authz-At`, `X-OA-Version` and `X-OA-Named` plus the new headers (one `presenceHeaders(...)` helper):
  - `hello carries you; the joiner gets the current roster right after hello`.
  - `a second socket's join reaches the first as one presence frame`.
  - `three joins inside PRESENCE_COALESCE_MS send one frame, flushed by the alarm`.
  - `two sockets of one key show once; closing one keeps the face`.
  - `a clean close leaves after PRESENCE_GRACE_MS, not before` (no frame at +4 s, frame at +5 s via alarm).
  - `a reconnect inside the grace keeps the original since and position` (close, reopen the same key 3 s later, roster order unchanged).
  - `a rejoin after the grace gets a fresh since` (moves to first).
  - `"ping" gets "pong" and does not close the socket; any other message still closes 1008` (keep `events.test.ts` "any client message closes the socket (1008)" passing).
  - `a pinging socket with no auto-response for PRESENCE_STALE_MS is closed by the alarm and leaves` (Review Focus 3).
  - `a socket opened without X-OA-Ping is never swept as stale` (Review Focus 1).
  - `while a ping=1 socket is open the alarm is armed at most PRESENCE_SWEEP_MS ahead; with only non-pinging sockets (or none) no sweep alarm is armed`.
  - `after a fresh instance on the same storage, the roster is rebuilt from attachments and viewer_presence_left` (Review Focus 2).
  - `a socket without X-OA-Viewer-Presence gets no presence frames and is not counted` (embeds).
  - `a stale socket (authorized at or before accessChangedAt() + SKEW_MS) never joins: it gets gone with retryAfterMs, then 4403; other viewers get no presence frame; no viewer_presence_left row` (Review Focus 6).
  - `a socket whose UserPresence.touch refuses (a revocation started after authzAt) never joins and writes no grace row` (Review Focus 6).
  - `closeActor("u:{id}") removes that person's face at once, with no grace row` (and with Task 6, their agents).
  - `closeSockets and destroy clear viewer_presence_left and viewer_presence_state`.
  - `presence frames carry no "u:", "ip:" or email substrings` (owner name set to a value containing "@" is fine; assert the attachment actor never leaks).
- [ ] **Step 2: Run** `pnpm --filter @oa/server gen && pnpm --filter @oa/server exec vitest run test/viewer-presence.do.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Constructor (new; `ArtifactRuntime` has none today): `constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PRESENCE_PING, PRESENCE_PONG)); }` (applies to data sockets too; harmless).
  - `fetch` (`/events`): parse `X-OA-Viewer-Presence` with a zod schema (400 on invalid) before accept; push `VIEWER_PRESENCE_TAG` into the accept tags (tags are fixed at `acceptWebSocket`); the first attachment stays `{ t, named? }` with no `p`. Run every join step only after both gates pass, where `if (hello) pair[1].send(hello)` is (`:1291`): build the seat with `since = viewer_presence_left.since ?? now` and delete that row; `serializeAttachment` again with `p` set; hello includes `you`; send the roster to the joiner; `viewerPresenceChanged()`; `armAt(min(t + SOCKET_TTL_MS, now + PRESENCE_SWEEP_MS))` when the socket pings. A refused socket (the `stale` / `touchPresence` branch at `:1250-1289`) never gets `p`.
  - A counted socket is one with the tag **and** `p` in its attachment. `flushViewerPresence`, the sweep and `webSocketClose` all skip tagged sockets without `p`.
  - `webSocketClose` (and a new `webSocketError` with the same body): only for a socket with `p`; when its key has no other open counted socket, upsert `viewer_presence_left` with `until = now + PRESENCE_GRACE_MS` and `actor = p.actor`, and `armAt(until)`. A socket that never joined writes nothing and broadcasts nothing.
  - `closeActor(actor)`: it is synchronous and closes the actor's `a:` / `ea:` sockets with 4403. A revoked person does not linger for the grace: before closing each socket, re-serialize its attachment without `p` (so `webSocketClose` writes no grace row for it); after the closes, delete `viewer_presence_left` rows with that `actor` and `ctx.waitUntil(this.viewerPresenceChanged())`. Task 6 adds the agent rows.
  - `viewerPresenceChanged`: if `now - sent_at >= PRESENCE_COALESCE_MS` flush now, else `armAt(sent_at + PRESENCE_COALESCE_MS)`.
  - `flushViewerPresence`: seats from `getWebSockets(VIEWER_PRESENCE_TAG)` attachments that have `p`, plus unexpired `viewer_presence_left`; `buildRoster`; skip when the JSON hash equals `viewer_presence_state.hash`; else send one serialized frame to all counted sockets and store hash and `sent_at`.
  - `alarm`: before the TTL loop, close pinging counted sockets whose `getWebSocketAutoResponseTimestamp(ws) ?? t` is older than `PRESENCE_STALE_MS` (close 1001 "stale", then the grace path); delete expired `viewer_presence_left`; flush if anything changed or a coalesce is due; include `now + PRESENCE_SWEEP_MS` (only while a pinging socket is open), the earliest `until`, and a pending coalesce in `next`. The early return at `:1539` (`!job && !thumb && sockets.length === 0`) also checks for `viewer_presence_left` rows and a pending coalesce.
  - `closeSockets` and `destroy` clear `viewer_presence_left` and `viewer_presence_state` (`destroy` already runs `deleteAll`).
- [ ] **Step 4: Run** the test file plus `test/events.test.ts test/runtime.do.test.ts test/alarm.cpu.test.ts test/presence.test.ts test/presence.class.test.ts`. Expected: PASS. Existing `events.test.ts` tests that read frames in order get a helper `nextOf(type)` that skips `presence` frames.
- [ ] **Step 5: Commit** `feat(server): viewer presence on the events socket`.

### Task 4: Events route passes presence identity

**Files:**
- Modify: `apps/server/src/runtime/routes.ts:464-509` (EVENTS handler), `apps/server/src/auth/keys.ts:13-29` (`KEY_OWNERS` gains `"oa:viewer-presence": "session"`)
- Create: `apps/server/src/runtime/viewer-presence-key.ts` (`viewerPresenceKey`)
- Test: `apps/server/test/events.test.ts` (new `describe("events socket: presence")`), `apps/server/test/keys.test.ts`

**Interfaces:**
- Consumes: Task 3 headers; Task 1 `PRESENCE_COOKIE`, `PRESENCE_ID_RE`; `isEmbedRequest` (`apps/server/src/http/embed.ts:146`).
- Produces: `viewerPresenceKey(env: Pick<Env,"SESSION_SECRET">, artifactId: string, identity: string): Promise<string>` = first 16 chars of `hmacSign(deriveKey(env,"oa:viewer-presence"), artifactId + "\0" + identity)`. Identities: `u:{userId}`, `p:{oa_pid}`, `s:{random}` (no valid cookie: one face per socket), `a:{session or connection}` (Task 6).
- Note: `KEY_LABELS` is `Object.keys(KEY_OWNERS)` (`keys.ts:41`) and `deriveKey` derives only labels owned by `"session"` (#591), so the label must be added to `KEY_OWNERS`, not to a list.

- [ ] **Step 1: Write the failing tests** in `events.test.ts`:
  - `two tabs of one signed-in person show once to a third viewer`.
  - `an anonymous viewer shows as Anonymous <Animal>; two tabs with one oa_pid show once`.
  - `the anonymous frame never carries the anonId, the oa_pid or the IP` (open with both an `oa.anonId`-minted token in play and a known `oa_pid`; assert neither string, nor `198.51.100.`, appears in any frame).
  - `a guest and a stranger on a public link see names but never emails` (owner with `name: null` shows as "Member"; owner email absent from every frame JSON).
  - `the presence key differs per artifact for the same person`.
  - `a malformed or 65-char oa_pid gives a per-socket face, not an error` (Review Focus 4).
  - `embed sockets (?embed=1 alone, X-OA-Embed alone, and both) are not counted and get no presence frames`.
  - `?ping=1 reaches the DO as X-OA-Ping; any other value is treated as not pinging`.
  - `keys.test.ts`: the exact-list assertion (`keys.test.ts:40-51`, `expect(KEY_LABELS).toEqual([...])`) fails until it lists `"oa:viewer-presence"` (Task 4) and `"oa:mcp-session"` (Task 5) in `KEY_OWNERS` order; update it, and the distinct-keys check then covers both.
- [ ] **Step 2: Run** `pnpm --filter @oa/server gen && pnpm --filter @oa/server exec vitest run test/events.test.ts test/keys.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** in the `EVENTS` handler: skip presence when `isEmbedRequest(c.req.raw)` or the existing `x-oa-embed` header check is true (middleware applies `?embed=1` by dropping the user, so the handler's `who` alone can't tell an embed from a plain anonymous viewer); signed-in: identity `u:{id}`, `name: cleanName(user.name)`, `guest: user.role === "guest"`, kind `person`; anonymous: `p:{oa_pid}` when it matches `PRESENCE_ID_RE`, else `s:{newId()}`, kind `anon`, name null. Read the cookie with Hono's `getCookie`. The handler already sends five headers (`Upgrade`, `X-OA-Actor`, `X-OA-Authz-At`, `X-OA-Version`, `X-OA-Named`); append `X-OA-Viewer-Presence` and `X-OA-Ping`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): events route sends the presence identity`.

### Task 5: Server-issued MCP session id (legacy era only)

**Files:**
- Create: `apps/server/src/mcp/session.ts`
- Modify: `apps/server/src/auth/keys.ts:13-29` (`KEY_OWNERS` gains `"oa:mcp-session": "session"`), `apps/server/src/mcp/server.ts:30-45` (`McpContext.connection`, `McpContext.session`; `ToolEnv` at `:47-50`), `apps/server/src/index.ts:52-83` (`mcpWithPat`), `apps/server/src/mcp/oauth.ts:117-177` (`apiHandler`; `GrantProps` at `:73-78`)
- Test: `apps/server/test/mcp-session.test.ts` (new)

**Interfaces:**
- Produces:
  - `MCP_SESSION_HEADER = "Mcp-Session-Id"`.
  - `LEGACY_SESSION_VERSIONS = ["2025-03-26", "2025-06-18", "2025-11-25"]`: the protocol revisions that define `Mcp-Session-Id`. MCP 2026-07-28 removed protocol-level sessions; its Streamable HTTP spec says a server receiving `Mcp-Session-Id` should ignore it and must not mint or echo session ids.
  - `mcpEra(req: Request, body: unknown): "legacy" | "modern"`: `"modern"` when the `MCP-Protocol-Version` request header is `2026-07-28` (the SDK requires it on every modern request POST) or the body carries the 2026-07-28 per-request `_meta` envelope; otherwise `"legacy"`.
  - `issueMcpSession(env, userId: string): Promise<string>` = `ms_<22 random base64url>.<hmac16>` bound to `userId`.
  - `verifyMcpSession(env, userId: string, value: string | null): Promise<string | null>` (the random part, or null when absent, over 128 chars or the signature fails).
  - `withMcpSession(req: Request, env: Env, userId: string, run: (session: string | null) => Promise<Response>): Promise<Response>`:
    - modern era: `session = null`; any incoming `Mcp-Session-Id` is ignored; the response never carries `Mcp-Session-Id`.
    - legacy era: verifies the request header; when the body is a JSON-RPC `initialize` (single object, `method === "initialize"`) whose `params.protocolVersion` is in `LEGACY_SESSION_VERSIONS`, adds a freshly issued `Mcp-Session-Id` to the response headers. Nothing else issues one.
  - `McpContext` gains `connection: string` and `session: string | null`. `connection` comes from `agent.via` through `viaKey` (`services/agent-usage.ts:23`): `t:<tokenId>` for a PAT, `g:<grantId>` for an OAuth grant. When an OAuth token has no parseable grant id (`grantIdOf` returns null, so `agent.via` is absent), `connection = "c:" + userId` (one face for that user's grantless connections). No new `pat:`/`oauth:` scheme; `GrantProps` (`{ userId, clientName, issuedAt }`) carries no client id.
- Note: the stateless handler rejects `sessionIdGenerator` and its transport ignores `Mcp-Session-Id` when stateless, so the header is added outside the SDK. Tools never see the raw header. Modern-era agents show as one face per connection in v1 (spec Section 5 and Section 9).

- [ ] **Step 1: Write the failing tests** (`mcp-session.test.ts`, using `connect`/`tool` from `test/mcp-helpers.ts`; `connect(token, { modern: true })` at `mcp-helpers.ts:45-50` selects the 2026-07-28 era):
  - `a legacy client gets an Mcp-Session-Id at initialize; tools/call does not issue a new one` (default `connect`, 2025 era).
  - `a 2025-03-26 initialize also gets one` (raw POST with that `protocolVersion`).
  - `a modern-era client (modern: true) gets no Mcp-Session-Id header on any response`.
  - `a modern-era request that sends a valid Mcp-Session-Id is not echoed and runs with session null`.
  - `a session id signed for another user verifies as null`.
  - `a tampered or 129-char session id verifies as null and the call still works`.
  - `a client that never echoes the header still works (session null)`.
  - `connection is t:<tokenId> for a PAT and g:<grantId> for an OAuth grant`.
- [ ] **Step 2: Run** `pnpm --filter @oa/server gen && pnpm --filter @oa/server exec vitest run test/mcp-session.test.ts test/mcp.auth.test.ts test/keys.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** and wire both entry points through `withMcpSession`, inside the existing `withCred(...)` (#808) so audit attribution still runs: in `mcpWithPat`, `withCred({ kind: "pat", ... }, () => withMcpSession(capped, env, user.id, (session) => mcpHandler(...).fetch(capped, { authInfo })))`; in `apiHandler`, the same around `mcpHandler(...)(capped, env, ctx)`, with `touchGrant` still in `waitUntil` after it. Read the body from a clone of the capped request.
- [ ] **Step 4: Run** the same command plus `test/mcp.tools.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mcp): server-issued Mcp-Session-Id for legacy-era clients`.

### Task 6: Agents on the roster

**Files:**
- Create: `apps/server/src/runtime/viewer-presence-agent.ts`
- Modify: `apps/server/src/runtime/do.ts` (table `viewer_presence_agent (key, product, owner, owner_actor, label, since, seen, last_write, activity)`; `touchViewerAgent` RPC, added to the `RpcMethods` union `:1791-1812`; optional trailing `touch?: AgentTouch` on `scheduleIndex :1354`, `get :675`, `count :688`, `list :701`, `query :728`, `set :860`, `setRaw :874`, `update :888`, `updateRaw :898`, `delete :934`; alarm expiry; `closeActor` cleanup; owner-only label variants in `flushViewerPresence`), `apps/server/src/services/artifacts.ts` (`enqueueIndex :81-110`, `publish :143`, `restoreVersion :1131` take `touch?: AgentTouch`; `versionEvent :112-125` unchanged), `apps/server/src/mcp/server.ts` (`ToolEnv.touch(id, write, activity)`), `apps/server/src/mcp/tools/artifacts.ts` (`publish_artifact :70-85`, `get_artifact :97-133`, `restore_version`), `apps/server/src/mcp/tools/data.ts` (all six, `:45-129`), `apps/server/src/routes/artifacts.ts` (`agentOf :101-108`; GET `R.artifact :165-167`, restore `:306-315`, publish `:375-393`, for PAT callers), `apps/server/src/runtime/routes.ts` (data routes for PAT callers), `apps/server/src/mcp/instructions.ts`
- Test: `apps/server/test/viewer-presence.agents.test.ts` (new)

**Interfaces:**
- Consumes: Task 5 `McpContext.session`, `.connection`; Task 4 `viewerPresenceKey`; Task 2 `AgentRow`, `buildRoster(...).labels`; `AgentAttr` (`services/agent-usage.ts:17-23`).
- Produces:
  - `viewerAgentTouch(env, artifactId: string, o: { user: Member; agent: AgentAttr | null; session: string | null; connection: string; write: boolean; activity: string | null }): Promise<AgentTouch>`: key = `viewerPresenceKey(env, artifactId, "a:" + (session ?? connection))`, `owner = cleanName(user.name) ?? "Member"` (never the email), `ownerActor = "u:" + user.id`, activity cut to 80, and:
    - `product = agent?.via?.kind === "grant" ? cleanName(agent.name) : null`. For a PAT, `agent.name` is the token label (`index.ts:69-73`, `routes/artifacts.ts:101-108`), so it must never become the product.
    - `label = agent?.via?.kind === "token" ? cleanName(agent.name) : (grant's owner-set label from #559, if loaded, else null)`. The label only ever lands in `buildRoster(...).labels`, which goes to the owner's sockets alone.
  - `touchViewerAgentLater(env, exec: Pick<ExecutionContext,"waitUntil"> | undefined, artifactId, o): void`: the one extra DO call (`runtimeStub(env, id).touchViewerAgent(touch)` in `waitUntil`, errors logged as `viewer_presence_touch_failed`; `presence_touch_failed` is the UserPresence accept path's log).
  - DO `touchViewerAgent(t: AgentTouch): Promise<void>`: upsert row (`since` kept, `seen = now`, `last_write = now` when `write`, activity replaced when given), `viewerPresenceChanged()`, `armAt(seen + AGENT_PRESENT_MS)`.
  - The data RPCs stay synchronous (they return `DataDoc` / `Page`, not a Promise). With `touch` set, they upsert the row synchronously (SQLite is sync) and defer the rest with `this.ctx.waitUntil(this.afterViewerAgentTouch(seen))` (`viewerPresenceChanged()` and `armAt`). `scheduleIndex` is already async and awaits them inline.
  - REST with a PAT: connection `t:<tokenId>`, no session.
  - Publish activity = `input.message`.
  - `publish` is `(env, user, input, agent, ctx?, mode = "any")` (#709/#792): append `touch?` after `mode`. Since #728, `enqueueIndex` (and with it `scheduleIndex` and the touch) runs in `waitUntil` via `later()` and never throws, so the touch lands after the response.
  - Settings-only `publish_artifact` (`publishSettings :1328`, #709) makes no DO call: it does not touch (no extra call for a settings change).
  - `closeActor("u:{id}")` also deletes `viewer_presence_agent` rows with `owner_actor = "u:{id}"`, so a revoked user's agents leave at once instead of after `AGENT_PRESENT_MS`.
  - The alarm's early return (`do.ts:1539`) also checks for `viewer_presence_agent` rows; expired rows are deleted and flushed there.
- [ ] **Step 1: Write the failing tests** (`viewer-presence.agents.test.ts`; await `waitUntil` work, as `callWorker` in `mcp-helpers.ts` does):
  - `an MCP get_artifact puts the agent on an open viewer's roster as "<product>", owner name, Viewing`.
  - `a publish through MCP makes it Editing with the change note as activity` (and costs no extra DO call: the touch rides `scheduleIndex`).
  - `a restore_version through MCP makes it Editing` (rides `restoreVersion`).
  - `a settings-only publish_artifact makes no DO call and no touch`.
  - `a data write through artifact_data_set makes it Editing` (rides the DO call).
  - `two legacy MCP sessions of one client show as "Claude Code" and "Claude Code-2"; one session's calls show once`.
  - `a client without the session header gets one face per connection`.
  - `a modern-era client (connect(token, { modern: true })) gets no Mcp-Session-Id and shows one face per connection across its calls`.
  - `an agent drops off AGENT_PRESENT_MS after its last request` (clock override, alarm).
  - `a PAT agent shows as "Agent" with no product`.
  - **`a PAT-connected agent's token label never reaches another viewer`**: open a named member socket, an anonymous socket, a guest socket and an embed socket (plus the owner's), make PAT calls with a distinctive label (for example `"label-7f3c secret"`) through MCP and REST, publish and read; assert the label string appears in no frame received by the named, anon, guest or embed sockets (embed gets no presence frames at all), and appears only in the owner's own variant as `agent.label`, never as `product` or `name`.
  - `an OAuth grant's product is its client name; a token's is never its label`.
  - `an owner with no name gives agent.owner "Member", never the email`.
  - `closeActor of the owner removes their agents at once`.
  - `activity over 80 chars is refused by the tool input; activity never appears for a non-agent`.
  - `REST GET R.artifact with a PAT adds the agent; with a session cookie it does not`.
- [ ] **Step 2: Run** `pnpm --filter @oa/server gen && pnpm --filter @oa/server exec vitest run test/viewer-presence.agents.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Instructions: add one line to `INSTRUCTIONS` asking agents to pass `activity` (a few words on what they are doing, at most 80 characters) on reads and data calls. Regenerate the skill and tool manifest with `pnpm --filter @oa/server gen` and commit the outputs.
- [ ] **Step 4: Run** the test file plus `test/mcp.tools.test.ts test/events.test.ts test/runtime.do.test.ts test/json-shapes.snapshot.test.ts test/mcp-publish.cpu.test.ts test/presence.test.ts`. Expected: PASS, snapshot unchanged.
- [ ] **Step 5: Commit** `feat(server): AI agents on the presence roster`.

### Task 7: Dashboard presence client

**Files:**
- Create: `apps/dashboard/src/viewer/presenceId.ts`, `apps/dashboard/src/viewer/usePresence.ts`
- Modify: `apps/dashboard/src/viewer/liveEvents.ts` (`ArtifactEventsOptions :15-34`, `eventsUrl :44-47`, `connectArtifactEvents :74-173`, with `gone()` at `:136-143` and `close()` at `:163-169`), `apps/dashboard/src/viewer/useLiveVersions.ts` (connect effect `:292-324`), `apps/dashboard/src/viewer/Shell.tsx`
- Test: `apps/dashboard/test/live-events.test.ts`, `apps/dashboard/test/presence.test.tsx` (new)

**Interfaces:**
- Consumes: Task 1 schemas, constants, mock `emitPresence`.
- Produces:
  - `presenceId(): string`: reads `oa_pid` from `document.cookie`, else mints 22 random base64url chars and writes the session cookie (Global Constraints attributes). Never touches `oa.anonId`; never throws.
  - `eventsUrl(id, embed)` adds `ping=1` (not in embed mode).
  - `ArtifactEventsOptions.onPresence?: (f: PresenceFrame, you: string | undefined) => void`; `onEvent`'s type becomes `Exclude<ArtifactEvent, { type: "gone" | "presence" }>` (today it excludes only `gone`, and useLiveVersions' else branch treats any non-hello frame as a version frame).
  - Ping: the socket sends `PRESENCE_PING` every `PRESENCE_PING_MS` while open, one interval per socket, and ignores `"pong"`. `onclose` returns early when `ws !== sock`, and both `gone()` (the #821 `notBefore` path) and `close()` set `ws = null` before `sock.close()`, so clearing only in `onclose` leaks the interval after gone or unmount and keeps it through `resume()`. Clear it in `gone()`, `close()` and `onclose`, and each tick also stops itself unless `ws === sock && sock.readyState === WebSocket.OPEN`. It sends no arrival time: the server keeps it across the grace.
  - `usePresence(): { others: PresenceEntry[]; total: number; onPresence }` (drops `you`, clears on gone). `onPresence` is stable (held in a ref inside `useLiveVersions`), because the connect effect's deps are `[id, embed, enqueue, check, goGone, generation]` and an unstable callback would reconnect the socket.
- [ ] **Step 1: Write the failing tests:**
  - `live-events.test.ts`: `sends "ping" every 30 s and only "ping"` (fake timers), `a 4408 reconnect carries ping=1 and no since`, `presence frames go to onPresence, not onEvent`, `embed mode sends no ping=1 and no ping frames`, `no ping is sent after gone, after close, or while paused, and resume starts exactly one interval`. Update the exact `eventsUrl` assertions at `live-events.test.ts:61-62` (`.../events`, `...?embed=1`) for `?ping=1`.
  - `presence.test.tsx`: `presenceId mints once and reuses the cookie`, `presenceId never reads or writes oa.anonId`, `usePresence hides you and keeps order`, `a gone artifact clears the roster`, `a new onPresence identity does not reconnect the socket`.
- [ ] **Step 2: Run** `pnpm --filter @oa/dashboard exec vitest run test/live-events.test.ts test/presence.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** The anonymous cookie is set before the first connect so the upgrade carries it; signed-in viewers set it too (the server ignores it for them).
- [ ] **Step 4: Run** the same command plus `test/live-versions.test.tsx test/shell.test.tsx`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(dashboard): presence client on the events socket`.

### Task 8: Animal icon set

**Files:**
- Create: `apps/dashboard/src/viewer/presence/animals.tsx`
- Test: `apps/dashboard/test/animals.test.tsx` (new)

**Interfaces:**
- Consumes: Task 1 `ANIMALS`, `AnimalId` (13 `lucide: true`, 45 drawn).
- Produces: `AnimalIcon({ id, className }: { id: AnimalId; className?: string }): JSX.Element` (an `aria-hidden` SVG, `stroke="currentColor"`, `fill="none"`, `strokeWidth={2}`, round caps and joins, `viewBox="0 0 24 24"`). Lucide animals come from `lucide-react` (`Bird`, `Bug`, `Cat`, `Dog`, `Fish`, `Panda`, `Rabbit`, `Rat`, `Shrimp`, `Snail`, `Squirrel`, `Turtle`, `Worm`); the 45 others are inline path data in this file, drawn by Design in the same style (4A).

- [ ] **Step 1: Write the failing tests:** `every ANIMALS id has an icon` (render each; assert an `svg` with `viewBox="0 0 24 24"`), `lucide: true ids render the lucide-react icon`, `drawn icons use only stroke, never fill` (no `fill` other than `none` in the markup), `no two drawn icons share path data`.
- [ ] **Step 2: Run** `pnpm --filter @oa/dashboard exec vitest run test/animals.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** with Design's drawn paths (Design delivers them as SVG; the implementer only transcribes). This task waits for all 45 drawings; no placeholder icons ship.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Verify visually** with the `proofshot` skill: every icon at 15px on each of the 9 palette colors, light and dark; send the sheet to Design.
- [ ] **Step 6: Commit** `feat(viewer): presence animal icons`.

### Task 9: Presence stack UI

**Files:**
- Create: `apps/dashboard/src/viewer/presence/PresenceStack.tsx`, `PresenceAvatar.tsx`, `PresenceCard.tsx`; palette tokens `--oa-presence-0` … `--oa-presence-8` in `apps/dashboard/src/viewer/viewer.css` (one set, no dark override, per 4A)
- Modify: `apps/dashboard/src/viewer/TitleBar.tsx:117-145` (new prop `presence?: ReactNode`) and `:262-263` (the right group opens at `:262`; render it first, at `:263`, before the version chip), `FullScreenEscape.tsx` (the same stack in the full-screen pill, placed per the Design page), `Shell.tsx` (renders `PresenceStack` unless embed or gone; `Viewer` renders `TitleBar` and `FullScreenEscape` once per layer, leaving, shown and preload, at `Shell.tsx:640-692`, so pass the stack the way `slot` is passed: to the shown layer only)
- Test: `apps/dashboard/test/presence-stack.test.tsx` (new), `apps/dashboard/e2e/presence.spec.ts` (new, mock)

**Interfaces:**
- Consumes: Task 7 `usePresence`; Task 8 `AnimalIcon`; Task 1 `PresenceEntry`; `initials` from `apps/dashboard/src/layout/UserAvatar.tsx:17` (grapheme-safe; call `initials(name, "")` so no email is used).
- Produces: `PresenceStack({ others, total }: { others: PresenceEntry[]; total: number })`; `PresenceAvatar({ entry, size }: { entry: PresenceEntry; size: 28 | 40 })` with `data-shape="circle" | "square"`; `presenceInitials(e: PresenceEntry): string` (`initials(e.name, "")` when `named`, else two letters from `key`; never an email; an agent shows its owner's initials). The agent square aligns with `settings/AgentRow.tsx:43-51` (rounded-square initials, `rounded-md`); share the style where sizes allow. Card copy (3A): person = name; anon = "Anonymous <Animal>" only; agent = name, "<Owner>'s agent · Viewing" or "· Editing", the activity in quotes with the caption "In the agent's own words"; a PAT agent with no product is named "Agent". The "+N" list header reads "<N> more here".
- Note: the version chip renders only when `authed` (`TitleBar.tsx:263`). For anonymous viewers there is no chip, so the stack is simply first in the right group. #794's "View only" badge is in the left group (`:236-252`) and does not conflict.

- [ ] **Step 1: Write the failing tests** (`presence-stack.test.tsx`):
  - `nobody else: renders nothing`.
  - `5 others: 3 faces then "+2"; exactly 4: all 4 faces, no "+1"`.
  - `"+N" opens a list headed "N more here" with the rest, agents with owner and state`.
  - `faces sit side by side (no negative margin) in arrival order`.
  - `clicking a face opens the card with the name only` (no `@` anywhere in the card's text).
  - `an anonymous card says "Anonymous Duck" and nothing else, with the duck icon`.
  - `an agent face is data-shape="square" with the owner's initials; its card shows "<Owner>'s agent · Editing", the quoted note and "In the agent's own words"`.
  - `color index i maps to --oa-presence-i`.
  - `a 500-char or HTML name renders as text, cut to 80` (Review Focus 5).
  - `each face has an accessible name; the stack is a labeled group`.
  - `with a preload layer mounted, exactly one stack renders`.
  - e2e `presence.spec.ts` (mock, `window.__oaEvents.emitPresence`): signed in, faces first in the right group, before the version chip; anonymous, faces first in the right group (no chip); exactly one stack in the DOM; `/full` shows the stack; at 390px one face plus "+N"; light and dark screenshots; embed shows nothing; a gone artifact shows no stack.
- [ ] **Step 2: Run** `pnpm --filter @oa/dashboard exec vitest run test/presence-stack.test.tsx` and `pnpm --filter @oa/dashboard exec playwright test e2e/presence.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** on `@oa/ui/shadcn` `Avatar`/`Popover`/`Tooltip` (hover = name tooltip, click = card). Do not reuse the `UserAvatar` component (its hue comes from the email); reuse only its `initials()` helper.
- [ ] **Step 4: Run** the same commands plus `pnpm --filter @oa/dashboard exec playwright test e2e/viewer-shadcn.spec.ts e2e/full-screen.spec.ts e2e/m2-a11y.spec.ts`. Expected: PASS.
- [ ] **Step 5: Verify visually** with the `proofshot` skill (header, card, "+N", phone, `/full`, light and dark) against the Design page; send the shots to Design.
- [ ] **Step 6: Commit** `feat(viewer): who's viewing in the header`.

### Task 10: Real end-to-end presence

**Files:**
- Create: `apps/dashboard/e2e/real/presence.spec.ts`

**Interfaces:**
- Consumes: everything above; `apps/dashboard/e2e/real/fixtures.ts` sign-in helpers and `mcp-client.ts` (`mcpWithToken`, `oauthSession`; both use the default 2025 `initialize` era, so this exercises the legacy session path; the 2026-07-28 era is covered by Tasks 5 and 6).

- [ ] **Step 1: Write the tests:**
  - `a member and an anonymous viewer on a public artifact see each other` (two browser contexts; anonymous sees the member's name; member sees "Anonymous <Animal>").
  - `two tabs of one member show once to the other viewer`.
  - `a closed tab leaves within 7 s`.
  - `an MCP client reading the artifact appears as a square agent face` (expiry is covered by Task 6's clock-driven test).
  - `no frame seen by the anonymous context contains an "@" or the PAT's label` (collect frames with `page.on("websocket")`; the MCP client connects with a PAT whose label is distinctive).
- [ ] **Step 2: Run** `pnpm --filter @oa/dashboard test:e2e:real -- e2e/real/presence.spec.ts`. Expected: PASS.
- [ ] **Step 3: Run the full suites** under the shared lock: `lockf -k /tmp/oa-fullsuite.lock sh -c "pnpm test && pnpm typecheck && pnpm lint"`. Expected: PASS.
- [ ] **Step 4: Commit** `test(e2e): viewer presence end to end`.

---

## Spec coverage

| Spec item | Task |
|---|---|
| Goal 1 stack, ordering, one face per person, you hidden | 2, 3, 7, 8 |
| Goal 2 initials, no photos; names never emails, "Member"/"Guest" | 2, 4, 8 |
| Goal 3 anonymous animals, sticky per browser session, unique per artifact, numbered when exhausted | 1, 2, 4, 7 |
| Goal 4 everyone sees everyone | 3, 4 |
| Goal 5 card, name only | 9 |
| Goal 6 agents, shape (1A), trust levels, session (legacy era; modern era one face per connection), unique names, activity, state | 5, 6, 9 |
| Token label to the owner only; product only from a grant | 6, 10 |
| Anti-goals: no leak, no cross-artifact linking, free plan, ghosts | 1, 3, 4 |
| Reconnect grace, server-kept arrival | 3 |
| Embeds not counted (Section 10, builder's lean: no) | 3, 4, 9 |
| `/full`, phones, deleted/no access | 9 |
| Animal icons (4A, ~45 to draw) | 8 |
| RBAC: revocation closes sockets (`closeActor`, P3 T7b) and removes faces and agents at once; refused sockets never join | 3, 6 |
| Contract record | 1 |
