// The hero's pinned scroll scene (#1457): one piece of work in four moments,
// shown as a transcript beside an artifact. The Astro page renders each moment
// as a card (the landed state, which is what scripts-off and reduced motion
// readers get); the browser script builds one pinned view and steps it through
// the same moments as you scroll. The agent replies are scripted.

/** [first moment it appears, class, html]. The moment is step * 10 + progress. */
export const SCENE_LINES: [number, string, string][] = [
  [10, "u", "&gt; which layout should the agents page use?"],
  [
    12,
    "",
    "● There are a few ways to approach this. A list only keeps things simple, but you lose the detail view.",
  ],
  [
    20,
    "",
    "● Read(apps/dashboard/src/pages/Agents.tsx)<span class=sub>⎿ Read 96 lines</span>",
  ],
  [
    20,
    "",
    '● Search(pattern: "AgentRow")<span class=sub>⎿ Found 14 files</span>',
  ],
  [
    21,
    "",
    "● Let me check how the Library handles the same problem before I recommend one.",
  ],
  [21, "", "● Read(Library.tsx)<span class=sub>⎿ Read 412 lines</span>"],
  [
    22,
    "dec",
    "● I'd go with list and detail, side by side. Want me to build it?",
  ],
  [22, "u", "&gt; yes, and show each agent's status"],
  [
    23,
    "",
    "● Edit(Agents.tsx)<span class=sub>⎿ Added 64 lines, removed 12</span>",
  ],
  [23, "", "● Bash(pnpm test agents)<span class=sub>⎿ 41 passed</span>"],
  [30, "", "● Edit(AgentDetail.tsx)<span class=sub>⎿ Added 118 lines</span>"],
  [31, "cmp", "Conversation compacted"],
  [32, "", "● Read(SidePanel.tsx)<span class=sub>⎿ Read 268 lines</span>"],
  [33, "", "● On a phone the detail now opens as a sheet."],
  [40, "", "● Bash(pnpm test)<span class=sub>⎿ 212 passed</span>"],
  [41, "", "● Tests cover both layouts now."],
];

type Moment = {
  t: string;
  a: string;
  ver: string;
  chip: string;
  ch: string;
  ask: string;
};
export const SCENE_STATES: (Moment | null)[] = [
  null,
  {
    t: "You ask.",
    a: "A new artifact, v1.",
    ver: "v1",
    chip: "Private",
    ch: "",
    ask: "",
  },
  {
    t: "The work scrolls away.",
    a: "Same page, updated.",
    ver: "v4",
    chip: "Private",
    ch: "What changed in v4",
    ask: "",
  },
  {
    t: "Sam never saw this chat.",
    a: "Sam comments on the page.",
    ver: "v5",
    chip: "Shared with 4",
    ch: "What changed in v5",
    ask: "",
  },
  {
    t: "The decision is in there somewhere.",
    a: "The decision is at the top.",
    ver: "v12",
    chip: "Shared with 4",
    ch: "What changed in v12",
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

export const SCENE_NOTE =
  "Same work. One is a scroll you search. The other is a page your team works on.";

const AGENT =
  '<svg viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><path d="M2 2l3 2h4l3-2v6a5 5 0 0 1-10 0z"></path></svg>';
const agent = (from?: number) =>
  `<span class="ag "${from ? ` data-from="${from}"` : ""}>${AGENT}</span>`;

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
    `<div class="x-art sc-art"><div class="x-abar"><span class="t">Agents page plan</span><span class="chip" data-k="chip">${S.chip}</span><span class="x-sp"></span>` +
    `<span class="pp${off(s < 3)}" data-from="3" aria-hidden="true">SR</span><span class="pp${off(s < 3)}" data-from="3" aria-hidden="true">MC</span>` +
    agent(3).replace('class="ag "', `class="ag${off(s < 3)}"`) +
    `<span class="chip ver" data-k="ver">${S.ver}</span></div>` +
    `<div class="x-abody">` +
    `<div class="x-blk hit${off(s < 4)}" data-from="4"><h4>Decision</h4><p class="x-dec"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"></path></svg><span>List and detail, side by side.</span></p><p class="x-sub">You picked it on Tuesday, from your phone.</p></div>` +
    `<div class="x-blk${off(s > 3)}" data-until="3"><h4>Proposal</h4><p class="sc-prop">Two layouts for the agents page: a list only, or a list with a detail pane. I recommend list and detail.</p></div>` +
    `<div class="x-blk${off(s < 2)}" data-from="2"><h4 data-k="ch">${S.ch}</h4><ul class="x-chg"><li>The list shows each agent's status.</li><li class="${off(s < 3).trim()}" data-from="3">On a phone, the detail opens as a sheet.</li><li class="${off(s < 4).trim()}" data-from="4">Tests cover both layouts.</li></ul></div>` +
    `<div class="x-blk${off(s < 3)}" data-from="3"><h4>Comments</h4>` +
    `<div class="x-cm${off(t < 30)}" data-at="30"><span class="pp" aria-hidden="true">SR</span><p><b>Sam Rivera</b>Can the list show status too?</p></div>` +
    `<div class="x-cm${off(t < 32)}" data-at="32">${agent()}<p><b>OA Product <span class="x-tag">agent</span></b>Added. It's in the next version.</p></div></div>` +
    `</div></div></figure></div>`
  );
}
