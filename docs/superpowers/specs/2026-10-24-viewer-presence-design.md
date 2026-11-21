# Viewer presence: design

Date: 2026-10-24
Status: Draft for approval

> **Revised 2026-10-29** against origin/main `5469cf78`, which had moved past #503 (UserPresence revocation gate), #814, #816 (`gone.retryAfterMs`) and #821 (client `notBefore`). Changes: MCP 2026-07-28 removed protocol-level sessions, so `Mcp-Session-Id` is issued only to legacy-era clients (2025-03-26 through 2025-11-25) at `initialize` and modern-era agents show as one face per connection in v1 (Section 5, Section 9); the product comes from the agent name only for an OAuth grant, and a token connection's label never reaches anyone but the owner (Section 5, tested in plan Task 6); revocation and refused sockets (Section 6); server-side names are `viewer_presence_*` to avoid confusion with the existing `UserPresence` revocation DO (Section 7). The plan carries the per-task details and line references.

## 1. Intent

When someone opens an artifact, the header shows who else has it open right now, the way Google Docs and Drive do. The goal is awareness: a glance tells you whether you're alone or whether teammates, strangers on a public link, or AI agents are on it with you. **The rule for every detail: mirror Google Drive's patterns** (user).

## 2. Goals

1. **Who's here now.** The viewer header shows a stack of avatars for everyone currently viewing the artifact (user).
2. **Signed-in people show as themselves.** Initials on a colored circle; name on hover (user). No photos for now (user); see Section 9.
3. **Anonymous viewers get an animal identity.** Someone not signed in shows as "Anonymous <Animal>" (for example "Anonymous Duck") with that animal's icon on a colored circle, like Google Docs. The identity sticks for their browser session (user).
4. **Everyone sees everyone.** Anyone who can open the artifact sees everyone else on it. A stranger on a public link sees the names of signed-in teammates, as in Google (user).
5. **Click shows identity.** Clicking an avatar opens a small card with the name. **Name only, never the email** (user).
6. **AI agents show too, and look different.** An agent reading or editing the artifact through MCP or the API appears in the stack, in a different shape (a square or a hexagon, not a circle) so it's easy to tell from people (user). Design brings options for the shape; the user picks.

## 3. Non-goals

- Live cursors, selections, or "who's editing which part".
- Follow mode, chat, or pinging a viewer from the card.
- A history of who viewed (that's analytics and the audit log, not presence).
- Showing presence inside the artifact frame or through the `window.openArtifacts` runtime.

## 4. Anti-goals

- **Leaking more than a name.** No email, no user id, no token id, no IP, and no anonId in any presence frame or card.
- **Linking an anonymous viewer across artifacts or sessions.** The animal must not be derivable from the existing signed `oa.anonId` (which lives in localStorage and identifies anonymous data writers). Presence must not let anyone correlate an anonymous viewer's data writes, or their visits to different artifacts.
- **Breaking the free plan.** Presence rides on what exists: no polling, no extra Worker request per viewer, and pings answered without waking the DO. The only new DO call is one per agent read (Section 5); agent data calls and publishes ride the DO call they already make.
- **Ghosts.** A person who closed the tab must not linger for more than a few seconds; one whose connection dropped (sleep, network loss) must be gone within about 90 seconds (coordinator's call, for cost).

## 5. How it behaves (Google patterns; details are my calls)

- **Header placement:** the avatar stack sits in the viewer title bar's right group, before the version chip, as Google places it before Share. Shown at most 3 or 4 avatars, then a "+N" chip; clicking "+N" lists the rest. (Exact count and spacing: Design.)
- **You don't see yourself** in the stack (Google does show you in some surfaces; Docs shows other people only in the header). My call.
- **One person, one avatar.** Several tabs or devices of the same signed-in person show once. One anonymous browser session with several tabs shows once.
- **Order:** most recent arrival first (Google). My call.
- **Colors:** each avatar's circle color is stable for that identity on that artifact during the session, from a fixed palette that works in light and dark. My call.
- **Anonymous names:** "Anonymous " + an animal from a fixed list (Google uses animals such as Duck, Capybara, Axolotl, Llama). Within one artifact, two anonymous viewers never share an animal while both are present. If the list runs out, add a number. My call.
- **Sticky for the browser session:** a fresh random presence id is kept in a session cookie on the app origin (no expiry, so the browser drops it when the session ends; shared by every tab of that browser). It's not the `oa.anonId`. The animal and color come from that id, so all tabs of one browser show one animal. A new browser session gets a new animal, as in Google. My call (from the builder check: `sessionStorage` would give each tab its own animal).
- **Agents: one face per agent session, in the shared identity card shape** (user, 2026-10-24; option C of the options page, step 1 of the shared-identity proposal). Each card field carries a trust level, and the UI never shows a self-reported field as fact:
  - **owner** (verified): the person whose sign-in the connection belongs to. The face shows the owner's initials inside the agent shape. The card says "<Owner name>'s agent".
  - **product** (self-reported): the OAuth client name the agent registered with ("Claude Code"), taken only when the connection is an OAuth grant. For a token connection there's no product; the card says "Agent". The token label (a token connection's agent name) shows to the owner only: it never reaches any other viewer, named, anonymous, guest or embed.
  - **session** (server-issued): the MCP Streamable HTTP session id (`Mcp-Session-Id`), issued at `initialize` only to legacy-era clients (protocol 2025-03-26 through 2025-11-25). One face per session. MCP 2026-07-28 removed protocol-level sessions (its Streamable HTTP spec says a server receiving `Mcp-Session-Id` should ignore it and not mint or echo session ids), so the server never mints or echoes it for 2026-07-28-era requests. **Known limit:** modern-era agents show as one face per connection in v1. Plain REST calls and legacy clients that don't keep the session also fall back to one face per connection.
  - **name** (server-assigned): the product name, made unique on the artifact with "-2", "-3" on a clash, the way OpenBus does ("Claude Code", "Claude Code-2"). Agents never name themselves as a trusted fact through tool arguments.
  - **activity** (self-reported): the change note from the agent's last publish, or an optional short "what I'm doing" field on reads and data calls, at most 80 characters, shown in quotes and labeled as the agent's own words. The MCP server instructions ask agents to set it.
  - **state**: "Editing" after a publish or data write, otherwise "Viewing".
- **Agent reads cost one DO call:** reads don't reach the artifact's DO today, so each agent read (MCP `get_artifact`, REST GET) adds one fire-and-forget DO call to record it. Agents are low volume, so the cost is small; reads are the only *new* DO call (the one exception to "no extra requests"); agent data calls and publishes record it inside the DO call they already make, through an optional touch argument. My call (from the builder check); data-call wording: coordinator's call. An agent session counts as present for about 2 minutes after its last request touching the artifact.
- **Names, never emails:** today `versionEvent` falls back to the email when a user has no name, and `UserAvatar` takes initials and hue from the email. Presence uses the name only; with no name, the label is "Member" (or "Guest" for a guest), and the initials and hue come from an opaque per-artifact key, not the email. The same rule applies to the owner in "Leo's agent". My call (from the builder check).
- **The card:** name; for an anonymous viewer, "Anonymous Duck" and nothing else; for an agent, its label, the owner's name, and Viewing or Editing. For signed-in people we show the name and initials only.
- **Where it shows:** the dashboard viewer and the full-screen view (`/full`). Embeds (`/embed`) have no header, so they show nothing; whether an embed viewer counts toward others' stacks is left to the builder (Section 9).
- **Phones:** the stack collapses to the first avatar plus "+N" (Design).
- **Deleted, no access, or gone:** no stack.
- **Self-hosted and hosted:** both. No setting to turn it off in M1. My call.

## 6. Constraints

- **Built on the existing artifact events socket.** The viewer already opens one `R.events` WebSocket per artifact to the per-artifact Durable Object (`ArtifactRuntime`, `apps/server/src/runtime/do.ts`), with hibernation, per-pool and per-actor socket budgets for signed-in and anonymous (ip) viewers, and viewer classes (named, anon, embed, guest). Presence uses that socket: joining is opening it, leaving is closing it (plus the runtime's existing close handling). No second socket.
- **Who you are comes from the server, never the client.** The DO takes the signed-in identity from the authenticated upgrade, as today. The client sends only its session presence id, and only for anonymous viewers; the server treats it as an opaque, length-capped random string, never as identity.
- **Name exposure is a change to an existing rule.** Today `broadcastVersion` gives named sockets `by.name` and anonymous, embed and guest sockets `{ kind }` only. Presence deliberately shows names to everyone who can open the artifact (Goal 4). That earlier rule stays as it is for version frames; presence frames have their own rule.
- **Dropped connections:** a clean close leaves at once. For a dropped one, the client sends a ping every ~30 s that the DO answers with `setWebSocketAutoResponse` (answered without waking the DO, so no duration billed); the existing alarm sweep removes sockets whose last auto-response timestamp is over 60 s old. The sweep runs every 30 s, armed only while at least one socket opened with ping=1 (no alarm when nobody is pinging), so the worst case is about 90 s. Sockets from older dashboards that never ping are never swept; they clear on close or at the socket TTL. My call (from the builder check); 60 s, 30 s and the ping=1 rule: coordinator's call (cost).
- **Reconnects don't reshuffle:** the 10-minute signed-URL reconnect (close 4408) and short drops keep a person's place: a leave is held for a ~5 s grace before it's broadcast, and the server keeps the person's arrival time across that grace (a reconnect inside it inherits the held arrival), so the client sends no arrival time. Coordinator's call.
- **Free plan:** presence frames are sent only on join, leave, and agent expiry, coalesced (a burst of joins sends one frame). No timers per socket; agent expiry uses the DO's existing alarm.
- **Copy:** no em dashes; say "any AI agent" where relevant.
- **RBAC:** visibility of presence follows the ability to open the artifact. Revoking someone's access closes their sockets (P3 T7b, `closeActor`), which removes them from the stack at once (no reconnect grace) along with their agents. A socket the server refuses right after opening (authorized just before an access change, or refused by the revocation gate) never joins the stack.

## 7. What a builder decides

- The presence frame's shape, coalescing window, and how a newly connected socket gets the current roster.
- The animal list (around 50 to 70 animals, family-friendly, each with an icon) and the color palette.
- Where the agent "last seen" signal is recorded on MCP and REST paths without adding a Worker request (for example, inside calls that already reach the DO).
- Internal names: the server already has a `UserPresence` DO (revocation) and `presence_*` logs, so this feature's tables, logs and keys are named `viewer_presence_*` (plan Global Constraints).
- Tests, including: two tabs of one person show once; a closed tab leaves within a few seconds; an anonymous viewer's frames never carry the anonId; a guest and a stranger see names but never emails; an agent drops off after the window.

## 8. Decided

| Decision | By |
| --- | --- |
| Show who's viewing now in the header, like Google Drive | user |
| Signed-in people by name; anonymous viewers as "Anonymous <Animal>", sticky per browser session | user |
| Everyone who can open it sees everyone, including strangers on public links | user |
| Clicking a face shows the name only, never the email | user |
| AI agents show too, in a different shape (square or hexagon; Design options) | user |
| One face per agent session, shared identity card shape with trust levels (option C) | user |
| Verified by OpenBus (signed identity card) is a joint follow-up after hosted M1 | user |
| Mirror Google Drive's patterns for every detail | user |
| Initials only; photos later | user |
| Design picks (https://artifacts.leourbina.com/a/MkqMepcHeLvbGvKL): 1A agents are a rounded square with the owner's initials and a color per session; 2A faces first in the title bar's right group, side by side (no overlap), 3 then "+N" (all 4 when exactly 4), phone shows one face and "+N"; 3A agent card is plain lines with its note in quotes captioned "In the agent's own words"; 4A line-icon animals and one 9-color palette for both themes (white glyph at least 5.4:1). About 45 animal icons need drawing. | user |
| Agents count as present ~2 minutes after their last request | my call |
| Session presence id separate from `oa.anonId` | my call |
| Dashboard viewer and `/full`; self-hosted and hosted; no off switch in M1 | my call |

## 9. Later

- **Verified by OpenBus** (user, 2026-10-24). An agent presents a short-lived identity card signed by OpenBus, which can attest the product and session from the agent's machine; Open Artifacts verifies it and shows "verified by OpenBus". Conditions: same human linked once by the owner; trust only the signed card; activity stays self-reported; no agent shown to someone who couldn't see it on the bus; revoking a machine in OpenBus drops its agents. Joint with OpenBus (#540).
- **One face per session for modern-era agents.** MCP 2026-07-28 has no protocol-level session, so v1 shows those agents one face per connection. A later version could key them on something the client sends per request, if the protocol or OpenBus provides it.
- **Profile photos** (user, 2026-10-24: initials for now). Google shows photos, but none exist in Open Artifacts today; adding them means taking the picture at sign-in, storing it and serving it.

## 10. Left to the builder

- Whether embed viewers count toward others' stacks (my lean: no, since embeds have no header).
- Guests are shown to others like members, with the label "Guest" when they have no name (Google shows outside viewers the same way). My call.
