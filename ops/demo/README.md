# Demo artifacts

Real-time demos for demo.open-artifacts.com, built only on `window.openArtifacts`.

- `artifacts/<slug>/index.html`: the artifact source, one self-contained file each.
- `seed/<slug>.json`: what the nightly reset writes. `collections` maps a collection
  name to `{ docId: data }`; the reset deletes every doc in a listed collection and
  writes the seed docs. Collections named by UTC day (`name-YYYYMMDD`) need no seed:
  the reset only prunes days older than yesterday.
- `artifacts.json`: published artifact ids per instance, used by the landing build.
- `artifacts/gallery/`: the front door. Signed-out visitors to the demo root land on it
  (`PUBLIC_HOME`). It lists the demos from one `DEMOS` array in the page; add a demo there
  once it is approved.

## Identity

Signed-in viewers are keyed by a hash of their email. Anonymous viewers use the server's
per-browser `anonId` (`viewer.anonId()`, else the `{ anonId }` that `viewer.get()` returns on
servers before it), so a reload keeps the same id. Without one, they fall back to a random
id per tab (the sandboxed frame has no persistent storage), and a reload counts as a new
browser. Tic-tac-toe and chess use the id only for their seat labels.

## Seeds

| Artifact | Seed |
| --- | --- |
| poll | None: votes live in `votes-YYYYMMDD` (UTC). |
| tictactoe | `game/game` back to an empty board with both seats open. The server's doc is the state: every write is a patch of the fields it changes (`board`, a seat), each window adopts the doc its own write returns and skips feed events older than the state it has. Seats are `{ id, at }` and nothing writes on a timer: a move restarts both seats' clocks, and a seat the game is waiting on shows as away after 5 minutes without a move and is free to take (a seat is never away while the game waits on the other player). An away player keeps the seat until someone takes it, and keeps it by moving; a seated player's Start over frees an away opponent. The id is only used for the seat labels (a guest name derived from it). |
| chess | `table/table` back to game `g0` with both seats open, and every doc in `moves` deleted. Moves are append-only docs (`moves/<g>-<nnn>`, UCI); every window replays them with the inline rules engine and drops any move that is not legal from the last accepted position, in sequence. Seats live in `table/table` and work as in tic-tac-toe: patches, adopted write results, no check-ins, and the 5 minute away rule; a seat's clock is the later of its claim and the game's last move. |
| pixels | None: pixels live in `canvas-YYYYMMDD` (UTC), one doc per row (`r00`..`r31`), one key per pixel (`c0`..`c31`, a palette index). A pixel is `update(row, { cN })`, a shallow merge, so painters in the same row never clobber each other. Any visitor can paint any pixel; the 4 second cooldown is per browser. |
| dashboard | `stats` emptied. Only Platform's demo-ops Worker writes, once a minute, with its token (`allowAnonymousWrites: false`): `stats/today` = `{ day, updatedAt, votes, gamesInProgress: { tictactoe, chess }, moves: { tictactoe, chess }, pixels, countries, pins, truncated? }` and `stats/hourly-YYYYMMDD` = `{ h: [24 writes per UTC hour] }`. `truncated` names metrics (`votes`, `pixels`, `pins`, `countries`, `moves.chess`, ...) that are lower bounds, shown as "400+". `missing` and `failed` name sources (`poll` feeds votes, `canvas` pixels, `map` countries and pins, `tictactoe` and `chess` their games and moves): a missing source shows "–" ("not available"), a failed one keeps the last value the page saw with a "delayed" hint. Hourly ignores `lastTotal` and `lastDay` and reads only `h`. The page only reads; it shows a stale badge when `updatedAt` is over 3 minutes old. |
| map | None: pins live in `pins-YYYYMMDD` (UTC), one doc per browser (keyed like the poll) holding `{ c }`, an ISO 3166-1 alpha-2 code. Windows count a pin only when `c` is in the page's built-in country list; changing your pick overwrites your doc. |

## Fake stats feed

`tools/fake-stats.mjs` stands in for the demo-ops Worker when testing the dashboard against a
local instance. It writes `stats/today` and `stats/hourly-YYYYMMDD` through the REST data API
every few seconds, with counts that grow like a busy demo:

```sh
node ops/demo/tools/fake-stats.mjs --origin http://localhost:8787 --artifact <id> --token <PAT>
```

`--every <s>` sets the interval (default 3), `--truncate pixels,moves.chess` marks metrics as lower
bounds, `--missing chess,map` and `--failed poll` mark sources as not deployed or failing (a failed
source's metrics are written as 0, so the page must keep its last value), `--chaos` picks random
truncated, missing and failed each tick, `--age 240` backdates `updatedAt` to show the stale state, and `--once` writes one tick
and exits. The token is a PAT of the artifact's owner (or set `OA_TOKEN`).

## Gallery placeholders

The gallery cannot know artifact ids or the app origin ahead of time, so the source holds
placeholders that the publish script fills before it uploads the page:

| Placeholder | Replaced with | Source |
| --- | --- | --- |
| `{{id:<slug>}}` | the bare artifact id of `artifacts/<slug>`, for example `CkyAe3uSYRnYthKz` | `ops/demo/ids.json` (`{ "<slug>": "<id>" }`) |
| `{{origin}}` | the app origin with no trailing slash, for example `https://demo.open-artifacts.com` | the instance being published to |

Publish the other demos first, write their ids to `ids.json`, then publish the gallery.
The other demos use the same placeholders for their cross-links (an "All demos" footer link to
the gallery, and the dashboard's tile labels to each demo), each hidden or left as plain text
until its id is filled. They need the gallery's id, so publish the gallery once, then republish
the demos with every id in `ids.json`.
The page links to `<origin>/a/<id>`. A card whose id is still a placeholder (or not a valid
id) is left out, so a demo that is not published yet never shows a dead link. If `{{origin}}`
is left unfilled the page falls back to `location.ancestorOrigins` (Chromium and Safari only),
then to a relative `/a/<id>`, which resolves against the content host and does not work.
This needs Platform's publish script to support it.

Navigation out of the artifact frame: the viewer sandbox allows popups that escape the
sandbox (`allow-popups-to-escape-sandbox`) but no top navigation. So every gallery link opens
a new tab (`target="_blank" rel="noopener"`), and "Open in two windows" takes two clicks,
one popup each, because browsers allow one popup per click.
