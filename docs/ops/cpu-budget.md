# CPU budget

Open Artifacts targets the Cloudflare Workers **Free** plan, where an
invocation should stay under **10 ms of CPU**. This page records how we
measure that and the decision we took for 0.2.0.

## The bar (2026-10-19)

Two conditions, both required:

1. **Zero CPU-limit kills on the Free path at realistic load.** Platform's
   staging run with `limits.cpu_ms = 10` is the evidence: any request the
   runtime stops for CPU (outcome `exceededCpu`, error 1102) fails the bar.
2. **Code CPU ≤ 2 ms per route (p95)**, pinned by `pnpm test:cpu`
   (`apps/server/test/code-cpu/routes.test.ts`): the real Worker in Node
   against in-process bindings, thread CPU minus D1, R2 and DO time (DO rows
   meter the DO invocation), p95 of 20 requests, 5 rounds. A stall in a
   handler fails its row. The 2 ms is on the reference laptop, where
   `GET /api/v1/me` takes 0.56 ms, so each row is asserted as a ratio: every
   round measures the row's p95 and `GET /api/v1/me`'s p95 back to back (the
   order alternating), and the median of row / me must stay at or under
   budget / 0.56. Both run in the same process at the same moment, so a
   slower runner (CI is about 3×) or load that changes mid-suite cancels out.
   `GET /api/v1/me` itself keeps an absolute bar of 2 ms × 4 (the most a runner
   may be slower), so a regression there can't widen every other row's bar.

This replaces the earlier bar, "staging cpuTime p95 ≤ 10 ms". Staging
`cpuTime` includes **8–15 ms of runtime overhead** that our code doesn't
control. A 1 KB publish, the control, was the worst row. A p95 on that
number measures the isolate, not us. What we control is our own code's CPU,
and what users feel is whether the runtime kills a request. The bar now
measures each of those directly.

### Latest measurements

Staging p95 is `cpuTime` from Platform's Free-like run: `PLAN=free`,
thumbnails off, n=12 per route, requests 2 s / 3 s apart. Code CPU is the
`test:cpu` row (Node proxy, p95, median of 5). "-" means that column has no
matching row.

| Route | Staging p95 ms (2 s / 3 s) | Code CPU p95 ms |
|---|---|---|
| `GET /healthz` | - (1 in the earlier isolated run) | 0.29 |
| `GET /api/v1/me` | - (4 in the earlier isolated run) | 0.56 |
| `GET /api/v1/artifacts?limit=25` | 11 / 10 | 1.18 |
| search | 12 / 6 | 1.26 |
| publish 1 KB (control) | **17 / 12** | - |
| inline publish 120 KB typical html | 10 / 8 | - |
| inline publish 128 KB escape-heavy | - | 0.99 |
| upload create (reserve) | 10 / 6 | 0.48 |
| upload PUT | 8 / 5 | 0.36 |
| publish `{ uploadId }` | 17 / 5 | 0.52 |
| data doc write 256 KB (Worker / DO) | - | 0.88 / 0.51 |
| data reset 500 docs / 1 MB (Worker / DO; DO bar 8 ms) | - | 0.69 / 3.5 |
| index alarm (DO) | 12 / 12 | 0.53 (64 KB html) |

The 1 KB publish control is the worst staging row while doing almost no
work, and where both columns have a number staging is 5–33× the code CPU:
that gap is runtime overhead, not our code.

Kills: none in this run (72 alarms ok, 192 requests 2xx). Staging is a
**Paid** account, though, so a request over 10 ms isn't killed there and the
run can't show kills. It is inconclusive for half 1 of the bar.

Kill check (2026-10-19): staging on PLAN=free with limits.cpu_ms=10, n=12 per
route at 2 s spacing: zero kills on every route, 0/36 alarms non-ok, all
requests 2xx. Requests that used 20–22 ms CPU were not killed, so the cap is
enforced leniently. Zero kills holds for this load; headroom under real
Workers Free is unproven.

## Decision (2026-10-19), superseded

The bar was **p95 ≤ 10 ms CPU for personal-scale traffic**, meaning requests
at least ~3 s apart. Every route met it.

Back-to-back large HTML publishes (250 KB, 2 s apart) still had a tail
(p95 16 ms). That burst pattern isn't realistic personal use, and Cloudflare
tolerates occasional overruns. For heavy or team use, Workers Paid ($5/mo) is
recommended; the self-hosting costs doc says so.

Follow-ups, which didn't block 0.2.0:
- ~~Inline HTML publishes over 128 KB go through the upload path~~: done, see
  below.
- The indexing alarm itself gets to p95 ≤ 10 ms.

## Inline limit: 128 KB (be/inline-128k)

The 250 KB burst tail was the request's own `JSON.parse` of an escape-heavy
body: every `"` and `\` in HTML doubles in JSON, so 250 KB of HTML is up to
500 KB to parse, and nothing on the server can publish it without parsing it.
So the fix is the contract: `LIMITS.inlineBytes` is now **128 KB** for every
format (it was 256 KB since C3). Anything larger goes through the upload path
(create_upload, PUT, then `files: { "<path>": { uploadId } }`), which streams
to R2 and never parses the file.

- The 413 `too_large` text (`INLINE_TOO_LARGE_MESSAGE`) spells out that path,
  for REST and for the MCP `publish_artifact` tool.
- The REST publish body cap is now `2 × inlineBytes + 64 KB` (320 KB): the
  worst legitimate body is 128 KB of quote and backslash text, escaped 2×.
  A body over the cap is refused from its `Content-Length`, before it is read
  or parsed, so an oversize escape-heavy burst costs no parse. A body under
  the cap but over the limit (for example 250 KB of plain text) is parsed
  once (plain JSON parses fast) and then gets the 413. Text made of control
  characters (escaped 6×) can hit the cap below 128 KB; it is refused with
  the same upload hint.
- The MCP body cap is unchanged: it is set by the largest
  `artifact_data_set` document (1 MB), not by inline publishes.
- `pnpm test:cpu` (`test/publish.cpu.test.ts`) asserts it: a 128 KB
  escape-heavy HTML publish costs < 10 ms more than a tiny one (local D1/R2
  I/O, off-isolate in production, cancels out), and 200 and 250 KB
  escape-heavy bodies get the 413 without the body being read (the 2 ms
  time is a report, see below).

## Gates and the report

`pnpm test:cpu` gates CI only on checks that hold on any runner: cost
relative to a tiny request or a baseline, size and ratio checks,
deterministic counts (bytes read, binding calls) and the calibrated code-CPU
bar in `test/code-cpu` (Node thread CPU). Relative gates measure the
baseline and the request interleaved (`pairedMs`, median of 7 pairs) and
scale their bound to the runner with `scaledBound`: X × clamp(tiny / ref,
1, 4), where tiny is the test's own baseline on this runner and ref the same
baseline on a dev laptop (recorded next to each `*_REF_MS` constant). A
runner 3× slower than a laptop gets a 3× wider bound. Absolute wall-clock bounds go through
`budget()` in `test/cpu-time.ts`: every run annotates
`<label>: <ms> ms (budget <max>)`, and only `pnpm test:cpu:strict`
(`CPU_STRICT=1`) asserts them, so a slow or noisy runner shows up in the
report instead of failing a merge.

## `GET /skill.md`

The skill is pre-rendered at build time (`scripts/emit-skill.ts`, Zod to JSON
Schema included) into `src/mcp/skill.generated.ts`. A request does one regex
fill of its `{{tokens}}`, memoized per isolate (host, plan and version are
fixed per deploy), with no session, D1 or Markdown work.
`test/skill.cpu.test.ts` asserts a first fill < 1 ms and the memoized route
< 2 ms end to end. On staging, measure it like `GET /healthz`.
`GET /upgrade.md` works the same way (`scripts/emit-upgrade.ts`,
`test/upgrade.cpu.test.ts`, same budgets).

## How we measure

Measurements run on **staging** after a deploy, using `wrangler tail`. Each
request carries a unique `?bench=<label>` marker, or a unique search term for
search, so other traffic is never counted. Every artifact the bench creates
is private and deleted afterwards. A tail event doesn't flag cold starts, so
"first" means the first request of a run right after a deploy.

## Results

cpuTime in ms. 20 runs per route unless noted.

### After #141 (c5dda24): mixed load, 2 s between requests

| Route | p50 | p95 | max | over 10 ms |
|---|---|---|---|---|
| `GET /healthz` | 0 | 1 | 1 | 0 |
| publish md 250 KB | 5 | 8 | 8 | 0 |
| publish html 100 KB | 4 | 8 | 8 | 0 |
| `GET /api/v1/artifacts?limit=25` | 6 | 10 | 10 | 0 |
| search | 5 | 10 | 13 | 1 |
| publish html 250 KB | 7 | **16** | 22 | 7 |
| indexing alarm (n=60) | 6 | **11** | 13 | 7 |

### After #141: publishes 3 s apart

| Route | p50 | p95 | max | over 10 ms |
|---|---|---|---|---|
| publish html 250 KB | 4 | 6 | 9 | 0 |
| publish md 250 KB | 4 | 6 | 7 | 0 |
| publish html 100 KB | 4 | 6 | 7 | 0 |
| indexing alarm (n=60) | 6 | 9 | 11 | 1 |

### GET routes in isolation, 50 back-to-back runs

| Route | p50 | p95 | max |
|---|---|---|---|
| `GET /healthz` | 0 | 1 | 1 |
| `GET /api/v1/me` (authenticated) | 2 | 4 | 5 |
| `GET /api/v1/artifacts?limit=25` | 3 | 5 | 11 (once) |

Run on their own, GET routes are cheap. Their tails appear only when they
share an isolate with recent large publishes and alarms.

### History

These numbers drove contract change C3 and the follow-up perf PRs.

| Change | Finding |
|---|---|
| Before C3 | 1.9 MB HTML publish at 40–83 ms. The cost was body handling, not indexing: base64 with no indexing was just as expensive. |
| #120 | Steady state: md 256 KB 7–9 ms, html 256 KB 12–28 ms |
| C3 (#126) | Inline publishes capped at 256 KB (larger returns 413, at 3–4 ms). Indexing moved to a Durable Object alarm. Steady state 4–9 ms, with a cold mode of 20–41 ms. |
| #134 | Eager isolate init plus the 128 KB index cap. Cold firsts dropped. |
| #141 | The table above. |
| be/inline-128k | Inline limit 256 → 128 KB; the publish body cap is now 2 × inline + 64 KB, checked before the body is read. |
| #223 | Staging regressions investigated: no code regression; staging p95 is mostly runtime overhead (alarm: 12 ms staging vs ~0.5 ms code). |
| be/cpu-bar-docs | New bar: zero Free kills (`limits.cpu_ms = 10` run) plus code CPU ≤ 2 ms per route in `test:cpu`. |

## Re-running

Code CPU: `pnpm --filter @oa/server test:cpu` (CI runs it on every PR).

Staging:

The bench scripts live in the Platform lead's scratchpad: `publish-bench.sh`
(mixed and spaced runs, knobs `SCEN`, `REPS`, `PUB_SLEEP`, `GAP`) and
`get-bench.sh`. They need the staging member PAT and a `wrangler` login. Ask
the Platform lead to run them after any change on a hot path.
