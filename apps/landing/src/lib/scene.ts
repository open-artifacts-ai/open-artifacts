// The hero's pinned scroll scene (#1457): one piece of work in four moments,
// shown as a transcript beside an artifact, then a turn where the transcript
// leaves and the story goes on as the artifact's chapters (steps 5 to 9). The
// Astro page renders each moment as a card (the landed state, which scripts-off
// and reduced-motion readers get); the browser script builds one pinned view and
// steps it through the same moments as you scroll. The agent replies are
// scripted.

/** How many steps the whole story has: four moments here, five chapters below. */
export const STORY_STEPS = 11;

/** Progress marks for step n of the story: one segment per step, no text. */
export function marksHtml(n: number): string {
  return `<span class="pm" aria-hidden="true">${Array.from(
    { length: STORY_STEPS },
    (_, i) => (i < n ? "<i class=on></i>" : "<i></i>"),
  ).join("")}</span>`;
}

/** [first moment it appears, class, html]. The moment is step * 10 + progress. */
export const SCENE_LINES: [number, string, string][] = [
  [10, "u", "&gt; plan our Q4 launch"],
  [
    12,
    "",
    "● There are a few ways to sequence this. Docs first keeps it simple, but pricing has to be ready the same day.",
  ],
  [20, "", "● Read(docs/pricing.md)<span class=sub>⎿ Read 96 lines</span>"],
  [
    20,
    "",
    '● Search(pattern: "launch")<span class=sub>⎿ Found 14 files</span>',
  ],
  [
    21,
    "",
    "● Let me check last quarter's launch notes before I suggest dates.",
  ],
  [21, "", "● Read(notes/q3-launch.md)<span class=sub>⎿ Read 412 lines</span>"],
  [22, "", "● I'd launch on Tuesday, Dec 2. Want a timeline?"],
  [22, "u", "&gt; yes, add a timeline and a checklist"],
  [23, "", "● Write(launch-plan.md)<span class=sub>⎿ Wrote 84 lines</span>"],
  [23, "", "● Bash(pnpm check:links)<span class=sub>⎿ 212 links ok</span>"],
  [30, "u", "&gt; sam says tuesday is the board meeting"],
  [31, "dec", "● Moved launch day to Thursday, Dec 4."],
  [32, "cmp", "Conversation compacted"],
  [33, "", "● Edit(launch-plan.md)<span class=sub>⎿ Changed 3 lines</span>"],
  [40, "", "● Read(docs/status.md)<span class=sub>⎿ Read 268 lines</span>"],
  [41, "", "● The status page is ready for launch day."],
];

type Moment = {
  t: string;
  a: string;
  ver: string;
  chip: string;
  ask: string;
};
export const SCENE_STATES: (Moment | null)[] = [
  null,
  {
    t: "You ask.",
    a: "A new artifact, v1.",
    ver: "v1",
    chip: "Private",
    ask: "",
  },
  {
    t: "The work scrolls away.",
    a: "Same page, updated.",
    ver: "v2",
    chip: "Private",
    ask: "",
  },
  {
    t: "Sam never saw this chat.",
    a: "Sam comments on the page.",
    ver: "v3",
    chip: "Shared with 4",
    ask: "",
  },
  {
    t: "The decision is in there somewhere.",
    a: "The decision is at the top.",
    ver: "v3",
    chip: "Shared with 4",
    ask: "&gt; wait, what did we decide?",
  },
];

export const SCENE_CAPTIONS: [string, string][] = [
  ["", ""],
  [
    "You ask a question.",
    "In a transcript, that's a prompt. In an artifact, it's the start of a page with a link.",
  ],
  [
    "The agent works.",
    "The transcript fills with tool calls and scrolls away. The artifact stays one page, and says what changed.",
  ],
  [
    "A teammate weighs in.",
    "Sam can't see your chat. Sam can open the artifact, comment on it, and get an answer from the agent.",
  ],
  [
    "A week later: what did we decide?",
    "The transcript makes you scroll back and search. The artifact has the decision at the top.",
  ],
];

export const SCENE_TURN: [string, string] = [
  "That's the last time you scroll for it.",
  "From here on there is no transcript. The work happens on the artifact.",
];

export const SCENE_NOTE =
  "Same work. One is a scroll you search. The other is a page your team works on.";

const AGENT =
  '<svg viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><path d="M2 2l3 2h4l3-2v6a5 5 0 0 1-10 0z"></path></svg>';
const agent = (from?: number) =>
  `<span class="ag"${from ? ` data-from="${from}"` : ""}>${AGENT}</span>`;

/** The comment thread on the launch-day line, as it stands at moment t. */
function thread(t: number): string {
  const off = (cond: boolean) => (cond ? " off" : "");
  return (
    `<div class="card sa-th"><div class="q">Launch day: Tuesday, Dec 2</div>` +
    `<div class="cm${off(t < 30)}" data-at="30"><span class="pp" aria-hidden="true">SR</span><div><div class="w">Sam Rivera</div><div class="x">Can we move this to Thursday? Tuesday is the board meeting.</div></div></div>` +
    `<div class="cm${off(t < 40)}" data-at="40">${agent()}<div><div class="w">OA Product <small>agent</small></div><div class="x">Moved to Thursday, Dec 4. That is v3.</div></div></div>` +
    `<div class="rf">Reply</div></div>`
  );
}

/**
 * The two panels for moment `t`, with the right parts shown. The browser
 * script builds this once for the pinned view (at moment 10) and then moves it
 * with set(); the page renders it four times, at 19, 29, 39 and 49.
 */
export function sceneHtml(t: number): string {
  const s = Math.max(1, Math.min(4, Math.floor(t / 10)));
  const S = SCENE_STATES[s] as Moment;
  const off = (cond: boolean) => (cond ? " off" : "");
  const roll = SCENE_LINES.map(
    ([at, cls, html]) =>
      `<p class="${cls}${t >= at ? " on" : ""}" data-at="${at}">${html}</p>`,
  ).join("");
  return (
    `<div class="x-sides" data-s="${s}">` +
    `<figure class="x-side"><figcaption><b>In a transcript</b><span class="x-stat" data-k="ts">${S.t}</span></figcaption>` +
    `<div class="x-term" aria-hidden="true"><div class="x-tbar"><span class="x-dots"><i></i><i></i><i></i></span><span>claude</span></div>` +
    `<div class="sc-clip"><div class="sc-roll">${roll}</div></div>` +
    `<p class="sc-note">Sam never saw this chat.</p><div class="sc-ask"><span data-k="ask">${S.ask}</span><i></i></div></div></figure>` +
    `<figure class="x-side"><figcaption><b>In an artifact</b><span class="x-stat ok" data-k="as">${S.a}</span></figcaption>` +
    `<div class="x-art sc-art"><div class="x-abar"><span class="t">Launch plan</span><span class="chip" data-k="chip">${S.chip}</span><span class="x-sp"></span>` +
    `<span class="pp${off(s < 3)}" data-from="3" aria-hidden="true">SR</span><span class="pp${off(s < 3)}" data-from="3" aria-hidden="true">MC</span>` +
    agent(3).replace('class="ag"', `class="ag${off(s < 3)}"`) +
    `<span class="chip ver" data-k="ver">${S.ver}</span><span class="sbtn sa-share">Share</span></div>` +
    `<div class="sa-main"><div class="sa-doc"><div class="x-abody">` +
    `<h3 class="sa-h1">Q4 launch plan</h3><p class="sa-by">${agent()}OA Product, for Maya Chen</p>` +
    `<div class="x-blk hit${off(s < 4)}" data-from="4"><h4>Decision</h4><p class="x-dec"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"></path></svg><span>Launch day is Thursday, Dec 4.</span></p><p class="x-sub">Sam asked for the change. OA Product updated the plan.</p></div>` +
    `<p class="sa-p sa-intro">We're opening sign-ups with a free first month on Solo. This plan is the one place the team and the agents work from.</p>` +
    `<p class="sa-p sa-ld${off(s > 1)}" data-until="1">Launch day: Tuesday, Dec 2.</p>` +
    `<div class="x-blk sa-blk${off(s < 2)}${s === 2 ? " hit" : ""}" data-from="2"><h4>Timeline</h4><ul class="tl"><li><span>Docs and pricing page ready</span><b>Nov 25</b></li><li data-k="ld" class="${s === 3 ? "sel" : ""}${s === 4 ? " chg" : ""}${s >= 4 ? " sw2" : ""}"><span>Launch day</span><b><span class="old">Tuesday, Dec 2</span><span class="new">Thursday, Dec 4</span></b></li><li class="sa-inline${off(s < 3)}" data-from="3">${thread(t)}</li><li><span>First-week review</span><b>Friday, Dec 12</b></li></ul></div>` +
    `<div class="x-blk sa-blk sa-cl${off(s < 2)}${s === 2 ? " hit" : ""}" data-from="2"><h4>Launch checklist</h4><ul class="cl"><li><span class="bx"></span><span class="lb">Pricing page reviewed</span></li><li><span class="bx"></span><span class="lb">Docs links checked</span></li><li><span class="bx"></span><span class="lb">Go or no-go call</span></li></ul></div>` +
    `</div></div><aside class="sa-side"><div class="sa-pane"><div class="sh"><span>Comments</span><span>1 open</span></div>${thread(t)}</div></aside></div></div></figure></div>`
  );
}
