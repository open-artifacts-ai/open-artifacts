// The scripted transcript behind the before/after hero. Shared by the Astro
// page (which renders the landed state in HTML) and the browser script (which
// redraws it for the Codex look and plays the scroll-back). The agent replies
// are scripted; the page says so next to the demo.

export type Look = "claude" | "codex";
export type Question = "dec" | "chg" | "team";
export type Line = {
  cls: "" | "u" | "tl" | "cmp";
  tag?: "dec" | "chg";
  text: string;
  sub?: string;
};

type Kind = "u" | "a" | "r" | "s" | "e" | "x" | "c";
const SCRIPT: [Kind, string, string?][] = [
  ["u", "which layout should the agents page use?"],
  [
    "a",
    "There are a few ways to approach this. A list only keeps things simple, but you lose the detail view. A list with a detail pane works better on wide screens.",
  ],
  ["r", "apps/dashboard/src/pages/Agents.tsx"],
  ["s", "AgentRow", "14 files"],
  [
    "a",
    "Let me check how the Library handles the same problem before I recommend one.",
  ],
  ["r", "Library.tsx", "412 lines"],
  ["r", "SidePanel.tsx", "268 lines"],
  [
    "a",
    "The Library uses a split view above 960px. I'd lean toward list and detail, but it depends on the phone layout.",
  ],
  ["u", "let me think about it"],
  ["u", "ok go with list and detail"],
  ["a", "Sounds good. I'll start with the list component."],
  ["e", "Agents.tsx", "+42 -17"],
  ["x", "pnpm test agents", "38 passed"],
  [
    "a",
    "The tests pass. One thing to flag: the status column needs a server change.",
  ],
  ["r", "apps/server/src/services/agents.ts"],
  ["e", "agents.ts", "+18 -3"],
  ["x", "pnpm typecheck", "2 errors"],
  ["a", "Two type errors from the new field. Fixing."],
  ["e", "shared/agents.ts", "+6 -1"],
  ["x", "pnpm typecheck", "ok"],
  ["u", "can the list show status too?"],
  ["a", "Yes. I'll add a status dot to each row."],
  ["e", "AgentRow.tsx", "+11 -2"],
  ["x", "pnpm test agents", "41 passed"],
  ["c", ""],
  [
    "a",
    "To recap the earlier discussion: we were comparing two layouts for the agents page, and I believe we leaned toward the split view, though I may be missing context.",
    "dec",
  ],
  ["u", "what about phones?"],
  ["a", "On a phone the detail could open as a sheet. Want me to try it?"],
  ["u", "yes"],
  ["e", "Agents.tsx", "+27 -9"],
  ["x", "pnpm test agents", "44 passed"],
  ["a", "Done. The detail opens as a sheet below 600px."],
  ["u", "wait, what did we decide about the layout?"],
  ["a", "Good question. Could you remind me which one you preferred?"],
];

const FORMAT = {
  claude: {
    u: (t: string) => `> ${t}`,
    a: (t: string) => `⏺ ${t}`,
    r: (f: string, n?: string): [string, string] => [
      `⏺ Read(${f})`,
      `⎿ Read ${n || "96 lines"}`,
    ],
    s: (p: string, n?: string): [string, string] => [
      `⏺ Search(pattern: "${p}")`,
      `⎿ Found ${n}`,
    ],
    e: (f: string, d: string): [string, string] => {
      const m = d.match(/\+(\d+) -(\d+)/) as RegExpMatchArray;
      return [
        `⏺ Update(${f})`,
        `⎿ Updated with ${m[1]} additions and ${m[2]} removals`,
      ];
    },
    x: (c: string, o?: string): [string, string] => [`⏺ Bash(${c})`, `⎿ ${o}`],
    c: () => "Conversation compacted",
  },
  codex: {
    u: (t: string) => `› ${t}`,
    a: (t: string) => t,
    r: (f: string): [string, string] => ["• Explored", `└ Read ${f}`],
    s: (p: string, n?: string): [string, string] => [
      "• Explored",
      `└ Search ${p} (${n})`,
    ],
    e: (f: string, d: string): [string] => [`• Edited ${f} (${d})`],
    x: (c: string, o?: string): [string, string] => [`• Ran ${c}`, `└ ${o}`],
    c: () => "Context compacted",
  },
} as const;

export function lines(look: Look): Line[] {
  const f = FORMAT[look];
  return SCRIPT.map(([k, a, b]): Line => {
    if (k === "c") return { cls: "cmp", text: f.c() };
    if (k === "u") return { cls: "u", text: f.u(a) };
    if (k === "a")
      return { cls: "", tag: b as "dec" | undefined, text: f.a(a) };
    const o = (f[k] as (a: string, b?: string) => string[])(a, b);
    return {
      cls: "tl",
      tag: k === "e" ? "chg" : undefined,
      text: o[0],
      sub: o[1],
    };
  });
}

/** The status line above the transcript once a question has landed. */
export function transcriptStatus(q: Question, ls: Line[]): string {
  const n = ls.length;
  if (q === "dec")
    return `${n - ls.findIndex((l) => l.tag === "dec")} messages back, and even the agent isn't sure.`;
  if (q === "chg") {
    const first = ls.findIndex((l) => l.tag === "chg");
    const edits = ls.filter((l) => l.tag === "chg").length;
    return `${edits} edits across ${n - first} messages. No summary.`;
  }
  return "Not in here. Your team never saw this chat.";
}

export const ARTIFACT_STATUS: Record<Question, string> = {
  dec: "At the top of the page.",
  chg: "In the version history, with what changed.",
  team: "In the comments, with the agent's reply.",
};
