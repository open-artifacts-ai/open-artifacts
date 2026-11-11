# Yjs room spike: results (#1100)

Throwaway. Do not merge. This spike measures the room that the
[Collaborative Docs design](https://artifacts.leourbina.com/a/aEocVC8bjqqwdoJd)
proposes: one Durable Object per doc, with hibernating WebSockets, y-protocols
sync and awareness, updates appended to DO SQLite, and compaction to one
snapshot. Everything ran locally (Miniflare/workerd and Node). Nothing was
deployed.

## Answer

- **Typing and cursors are cheap at any doc size.** The room handles one
  keystroke or awareness message in **0.06 to 0.13 ms** of DO time, including
  the SQLite append and the broadcast to 19 peers. That is about 1% of the
  10 ms Free budget. Twenty editors typing 5 keys/s cost the room about 10 ms
  of CPU per second.
- **Anything that touches the whole doc grows linearly with doc size and
  breaks the Free 10 ms budget well before 1 MB.** That covers waking from
  hibernation, giving a new joiner the full state, compaction and an agent's
  `edit_doc`. On a 1 MB doc: cold wake takes 29 to 74 ms, a full-state join
  13 to 30 ms, compaction 11 to 24 ms, and a cold `edit_doc` 95 to 110 ms.
  On 2 MB, a cold `edit_doc` takes 120 to 440 ms.
- **The Free quotas bind before CPU does.** Writing one row per update used up
  2,600 rows in a 9-second test. At that rate the account's 100,000 rows/day
  would last about 17 minutes of one 20-person room. Batching the writes to one
  merged row per second per room brought the same test down to **9 rows**.

### Recommended caps

| | Free (10 ms CPU per invocation) | Paid |
|---|---|---|
| **Doc size** (stored Yjs state) | **128 KB** (about 30k to 65k characters, 10 to 20 pages). Fall back to 64 KB if production CPU turns out slower than this laptop. | **2 MB** |
| **Editors in a room at once** | **25** | **25** in slice 1, then 50 after a production load check |

Why these numbers:

- **Free doc size.** On Free, the slowest operation that must still run in the
  room is a cold agent edit (load, then `edit_doc`). It costs about 84 ms per MB
  for heavily edited docs and 44 ms per MB for prose. At 128 KB that is 6 to
  11 ms locally: prose fits, and heavily edited docs sit right at the limit,
  hence the 64 KB fallback. The cap also assumes the room never loads the doc
  on the typing, wake or join path (see "Room shape" below). A 2 MB doc
  cannot fit Free under either design: its cold edit alone takes 120 ms or
  more.
- **Paid doc size.** At 2 MB, the heap is 27 to 40 MB of the 128 MB isolate
  (compaction briefly needs a second copy), a cold wake is 80 to 160 ms, and a
  cold edit is 0.12 to 0.44 s. At 4 MB the heap reaches 52 to 76 MB, and cold
  loads of 0.2 to 0.75 s would stall the room for everyone (an anti-goal).
- **Editors.** CPU does not limit editors: 50 editors would use about 2.5% of
  the DO. The real limits are the join storm, where every joiner with an empty
  doc needs the full state (13 to 30 ms each per MB on the load-the-doc
  design), and the Free account's daily quotas. 25 keeps headroom over the
  20 editors measured here.

The design's starting limits (2 MB, 50 editors) hold for Paid on size. They
do not hold for Free. The design says Free is a hard requirement and the cap
shrinks until it fits, so a Free cap of 128 KB is what that rule produces.
Whether one cap should apply everywhere or the cap should depend on the plan
is Product's call (see Open questions).

### Room shape slice 1 should use

1. **Relay first: don't load the Y.Doc on wake.** For typing, the room only
   appends the raw update and broadcasts it. Joiners get the stored snapshot
   and the update rows as they are: reading them from SQLite took 1 ms even at
   2 MB. Keep a state vector up to date incrementally, so the room can answer
   sync step 1 without parsing the doc. With this, wake and typing cost the
   same at any doc size. Load the doc only for `edit_doc`, compaction and
   version snapshots.
2. **Batch persistence.** Merge pending updates and write at most one row per
   second per room. Alarms count as writes, so arm one only when the buffer
   was empty. Connected clients hold any unflushed edits and resend them on
   reconnect.
3. **Compact when a version is saved, not after a row count.** Compaction
   costs 11 to 19 ms per MB on a doc that is already loaded.
4. **Throttle client messages.** Batch keystroke updates on the client for
   50 to 100 ms and send cursors at most every 250 ms. At 20:1 billing,
   100 messages/s works out to 5 requests/s, so the Free account's 100k
   requests/day last about 5.5 hours of one 20-person room.
5. **Load with `applyUpdate` and never with `mergeUpdates`.** Merging first
   was 2 to 4 times slower.
6. **`edit_doc` cost is mostly building the text index** (about 10 ms per MB).
   Cache the index while the room is warm.

## Measurements

The machine was an Apple M1 Max, with Node 26.13.0 (V8 14.6) and
workerd 1.20260730.1 through Miniflare 4.20260730.0. "In DO" means timed
inside the Durable Object with `performance.now()`, which advances under local
workerd (production freezes it). These are laptop numbers: production per-core
speed is unverified.

### Fixtures

The fixtures are deterministic docs that 20 editors built until the encoded
Yjs state reached the target size. They come in two profiles:

- **heavy:** editors jump around, delete and bold often, which gives many
  small Yjs items per byte. This is the slow case.
- **typing:** mostly continuous typing, closer to people writing prose.

Every room also holds 2,000 keystroke update rows on top of the snapshot,
which is the uncompacted tail.

| profile, size | edits in history | text chars | blocks | Yjs structs | heap (MB) |
|---|---|---|---|---|---|
| heavy 0.25 MB | 18,000 | 67k | 619 | 20k | 5 |
| heavy 1 MB | 68,000 | 245k | 2,149 | 74k | 21 |
| heavy 2 MB | 132,000 | 471k | 4,090 | 142k | 40 |
| heavy 4 MB | 258,000 | 915k | 7,830 | 274k | 76 |
| typing 0.25 MB | 26,000 | 131k | 306 | 13k | 4 |
| typing 1 MB | 106,000 | 522k | 1,100 | 48k | 14 |
| typing 2 MB | 208,000 | 1.02M | 2,096 | 92k | 27 |
| typing 4 MB | 408,000 | 1.99M | 4,085 | 179k | 52 |

Costs follow the struct count more closely than the byte count.

### Cold wake (workerd, in DO; snapshot plus 2,000 update rows)

| | 0.25 MB | 0.5 MB | 1 MB | 2 MB |
|---|---|---|---|---|
| heavy | 16 to 19 ms | 39 to 40 | 72 to 74 | 156 to 188 |
| heavy, just compacted | 12 to 14 | 24 to 25 | 70 to 79 | 151 to 162 |
| typing | 10 | 16 to 19 | 35 to 46 | 80 to 103 |
| SQLite reads alone | 1 | 1 | 1 | 1 |

An empty room wakes in 0 ms of DO time (1.7 to 2.2 ms of wall time from the
caller). The bundled worker is 86 KB.

### 20 editors on a 1 MB doc (workerd, in DO)

| | heavy, row per update | heavy, 1 s batched rows | typing, row per update |
|---|---|---|---|
| join: slowest message (full-state sync step 2) | 18 to 30 ms | 17 to 38 | 13 to 19 |
| keystroke/awareness, paced (20 x 5/s, 6 s) | 0.10 to 0.11 ms | 0.07 to 0.08 | 0.08 to 0.13 |
| keystroke, burst (2,000 messages) | 0.07 ms | 0.06 | 0.06 to 0.07 |
| rows written | 2,600 | **9** | 2,600 |
| compaction afterwards | 16 to 19 ms | 17 | 11 |

The burst ran at about 1,100 messages/s end to end. Most of that limit comes
from the harness: one Node process runs all 20 client docs through Miniflare's
socket proxy. For the same reason, the measured end-to-end latency (0.2 s on
typing docs, 1.6 s on heavy ones) is the harness's backlog and not the room's.
The room's share is the in-DO time above.

### Pure Yjs costs (Node, same V8; no SQLite)

| | heavy 0.25 MB | heavy 1 MB | heavy 2 MB | heavy 4 MB | typing 1 MB | typing 2 MB |
|---|---|---|---|---|---|---|
| load snapshot + tail | 18 ms | 78 | 175 | 752 | 54 | 140 |
| load via `mergeUpdates` first | 62 | 150 | 288 | 1002 | 134 | 234 |
| compaction (encode a loaded doc) | 4.8 | 17 | 78 | 86 | 13 | 25 |
| compaction offline (`mergeUpdates`) | 50 | 68 | 104 | 577 | 69 | 83 |
| state vector from the snapshot | 3.6 | 13 | 28 | 147 | 9 | 20 |
| join, empty client (full state) | 3.5 | 16 | 38 | 146 | 19 | 33 |
| join, up-to-date client | 0.2 | 1.2 | 2.9 | 19 | 1.0 | 1.8 |
| keystroke apply, p50 / p99 | 0.01 / 0.06 | 0.01 / 0.05 | 0.01 / 0.04 | 0.02 / 0.08 | 0.01 / 0.12 | 0.01 / 0.07 |
| 20 KB paste apply | 0.11 | 0.05 | 0.05 | 0.06 | 0.05 | 0.05 |
| text index (read_doc base) | 1.1 | 10 | 18 | 39 | 4.2 | 12 |
| edit_doc, 1 op (warm) | 1.4 | 8.3 | 18 | 39 | 3.4 | 12 |
| edit_doc, 10 ops (warm) | 2.0 | 16 | 22 | 45 | 5.5 | 17 |
| edit_doc, 50 ops (warm) | 2.8 | 16 | 30 | 70 | 16 | 34 |

### Agent edit_doc on 2 MB (workerd)

| | heavy 2 MB | typing 2 MB | heavy 1 MB |
|---|---|---|---|
| warm, 1 op (in DO) | 13 to 14 ms | 8 to 20 | 6 to 9 |
| warm, 10 ops (in DO) | 17 to 21 | 11 to 39 | 7 to 13 |
| warm, 50 ops (in DO) | 24 to 62 | 28 to 53 | 13 to 25 |
| cold (wake + edit), 1 op (wall) | 210 to 212 | 122 to 286 | 95 to 201 |
| cold, 50 ops (wall) | 200 to 441 | 139 to 433 | 105 to 229 |
| compaction after the edits (in DO) | 76 to 89 | 31 to 181 | 24 to 68 |

The ranges span two full runs. Variance on the laptop is large, so read the
lower end as the cost and the upper end as noise from a busy machine.

### Limits these were compared against

These come from Cloudflare docs, read 2026-11-11:

- **CPU:** a Durable Object is a Worker, and Workers Free allows **10 ms CPU
  per invocation**. Each HTTP request, WebSocket message and alarm is its own
  invocation. This repo already budgets DO alarms at 10 ms on Free (for
  example `apps/server/test/directory.cpu.test.ts`). However, the DO limits
  page also says a DO's default is 30 s per invocation. That conflict is
  open question 1.
- **Memory:** 128 MB per isolate, shared by every DO in the isolate.
- **SQLite:** at most 8 MB per row or BLOB. Free allows 100,000 rows written
  and 5 million rows read per day, and 5 GB stored per account.
- **Requests:** Free allows 100,000 DO requests per day. Incoming WebSocket
  messages are billed at 20:1, and outgoing messages are free. Free also
  allows 13,000 GB-s of duration per day, and a hibernated DO is not billed
  for duration.
- **WebSocket messages:** at most 32 MiB each.

## Open questions

1. **Does the 10 ms Free CPU limit really apply to DO WebSocket messages?** The
   DO limits page says the default is 30 s per invocation. The Workers page
   says Free gets 10 ms. The fastest check is one deploy of
   this room to a Free account, timing a 1 MB cold wake: that tells us
   whether the limit applies and how fast production CPU is compared with this
   laptop. This spike deploys nothing, so that check needs a go.
2. **One cap everywhere, or a cap by plan?** Free supports 128 KB, Paid
   supports 2 MB. A single 128 KB cap keeps the docs feature the same on
   every plan, but it is small for team docs.
3. **Agent edits on Free above the cap?** One option is to apply `edit_doc` in
   a connected editor's browser when one is open. That is more complex, and it
   does not help when nobody has the doc open.

## What the spike skips

- `edit_doc` handles single-block quotes only, and it treats Markdown as plain
  paragraphs. A real Markdown parser plus the ProseMirror schema conversion
  would add cost on top of the text-index time.
- Awareness messages are relayed as is. The room keeps only each socket's
  client IDs, so it can announce removals when a socket closes.
- With batched rows, edits still pending in memory are lost if the DO is
  evicted before its 1 s alarm fires. Clients resend them on reconnect.
- There is no auth, no versions and no size enforcement.

## How to run

```sh
cd spikes/yjs-room
pnpm install --ignore-workspace       # standalone; not a workspace package
pnpm fixture 1000000 2000 heavy       # optional: fixtures build on demand into .fixtures/
pnpm bench:node                       # pure Yjs costs (about 3 min)
pnpm bench:do                         # the room in local workerd (about 2 min)
```

Files:

- `src/room.ts`: the room DO.
- `src/doc-model.ts`: the doc shape and `edit_doc`.
- `bench/fixture.ts`: the fixture generator.
- `bench/node-bench.ts` and `bench/do-bench.ts`: the two benchmarks.
- `results/`: the raw JSON from the runs quoted above (two runs of the DO
  bench, one of the Node bench).
