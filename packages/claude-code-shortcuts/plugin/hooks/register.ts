import {
  applyPublish,
  checked,
  deletion,
  dropRow,
  originOf,
  published,
  record,
  reinstate,
  restore,
  retitle,
  type Shortcut,
  titleOf,
  undeletion,
} from "./model.ts";

const WIDE: [number, number][] = [
  [0x1100, 0x115f],
  [0x2329, 0x232a],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4dc0, 0x4dff],
  [0x4e00, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe3],
  [0x17000, 0x18d08],
  [0x1aff0, 0x1b2fb],
  [0x1d300, 0x1d376],
  [0x1f200, 0x1f265],
  [0x1f300, 0x1faff],
  [0x20000, 0x3fffd],
];

// Terminal cells for one code point: combining marks, ZWJ and variation
// selectors 0, East Asian wide 2, the rest 1.
function cellOf(c: number): number {
  if (
    /^\p{M}$/u.test(String.fromCodePoint(c)) ||
    c === 0x200b ||
    c === 0x200d ||
    (c >= 0xfe00 && c <= 0xfe0f)
  )
    return 0;
  return WIDE.some(([lo, hi]) => c >= lo && c <= hi) ? 2 : 1;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (x) => x.segment);
}

// Terminal cells for one grapheme. Emoji, flags and keycaps take 2.
function cellsOf(g: string): number {
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(g))
    return 2;
  let n = 0;
  for (const ch of g) n += cellOf(ch.codePointAt(0) ?? 0);
  return n;
}

function cells(text: string): number {
  let n = 0;
  for (const g of graphemes(text)) n += cellsOf(g);
  return n;
}

// The text cut with "…" to at most `room` cells, never inside a grapheme.
function clip(text: string, room: number): string {
  if (cells(text) <= room) return text;
  let out = "";
  let used = 0;
  for (const g of graphemes(text)) {
    const w = cellsOf(g);
    if (used + w > room - 1) break;
    out += g;
    used += w;
  }
  return `${out}…`;
}

// The small public API surface this plugin uses; no client internals or credentials.
type Event = Record<string, unknown>;
type Next = (event: Event) => Promise<unknown>;
type Elements = {
  Box: (props: Record<string, unknown>) => unknown;
  Text: (props: Record<string, unknown>) => unknown;
  Link: (props: { href: string; label: string }) => unknown;
};
type Api = {
  session: { id: () => Promise<string> };
  store: {
    get: (key: string) => Promise<unknown>;
    set: (key: string, value: unknown) => Promise<void>;
  };
  ui: {
    invalidate: (event: string) => void;
    resolve: (event: Event) => Elements;
  };
  clock: { now: () => Promise<number> };
  command: {
    register: (command: {
      name: string;
      description: string;
    }) => Promise<unknown>;
  };
};
type Hook = ($: Api, event: Event, next: Next) => Promise<unknown>;
type On = (event: string, matcher: Event | Hook, hook?: Hook) => unknown;

function key(origin: string, session: string) {
  return `artifacts:${JSON.stringify([origin, session])}`;
}

async function load(
  $: Api,
  session: string,
  origin: string,
): Promise<Shortcut[]> {
  return restore(await $.store.get(key(origin, session)), origin);
}

/** Rows dropped by delete_artifact, kept so a successful undelete can restore them. */
function deletedKey(origin: string, session: string) {
  return `deleted-${key(origin, session)}`;
}

// Serialize one session's writes without coupling different sessions.
function save(
  $: Api,
  session: string,
  origin: string,
  writes: Map<string, Promise<void>>,
  update: (rows: Shortcut[]) => Shortcut[],
) {
  const k = key(origin, session);
  const write = (writes.get(k) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const rows = await load($, session, origin);
      const updated = update(rows);
      if (updated !== rows) await $.store.set(k, updated);
    });
  writes.set(k, write);
  void write
    .finally(() => {
      if (writes.get(k) === write) writes.delete(k);
    })
    .catch(() => {});
  return write;
}

/** Applies `update` to the rows and the deleted list as one serialized write. */
function saveBoth(
  $: Api,
  session: string,
  origin: string,
  writes: Map<string, Promise<void>>,
  update: (
    rows: Shortcut[],
    deleted: Shortcut[],
  ) => { rows: Shortcut[]; deleted: Shortcut[] } | null,
) {
  const k = key(origin, session);
  const write = (writes.get(k) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const rows = await load($, session, origin);
      const deleted = restore(
        await $.store.get(deletedKey(origin, session)),
        origin,
      );
      const next = update(rows, deleted);
      if (!next) return;
      if (next.deleted !== deleted)
        await $.store.set(deletedKey(origin, session), next.deleted);
      if (next.rows !== rows) await $.store.set(k, next.rows);
    });
  writes.set(k, write);
  void write
    .finally(() => {
      if (writes.get(k) === write) writes.delete(k);
    })
    .catch(() => {});
  return write;
}

export function register(
  on: On,
  options: Readonly<Record<string, unknown>> = {},
) {
  const origin = originOf(options.instanceUrl);
  const namespace =
    typeof options.mcpServer === "string"
      ? options.mcpServer
      : "open-artifacts";
  const validNamespace = /^[A-Za-z0-9_-]+$/.test(namespace);
  const publishTool = `mcp__${namespace}__publish_artifact`;
  const deleteTool = `mcp__${namespace}__delete_artifact`;
  const undeleteTool = `mcp__${namespace}__undelete_artifact`;
  const readTool = `mcp__${namespace}__get_artifact`;
  const writes = new Map<string, Promise<void>>();

  on("session.start", async ($, e, next) => {
    try {
      await $.command.register({
        name: "oa-artifacts",
        description:
          "Show this session's published artifact links and checked versions",
      });
    } catch {
      /* Managed policy may withhold commands; never change that policy. */
    }
    return next(e);
  });

  on(
    "tool.call",
    { tool: [publishTool, readTool, deleteTool, undeleteTool] },
    async ($, e, next) => {
      if (!origin || !validNamespace) return next(e);
      let session: string | undefined;
      try {
        session = await $.session.id();
      } catch {
        /* Presentation is optional. */
      }
      const result = await next(e);
      if (!session) return result;
      try {
        if (e.tool === publishTool) {
          const receipt = published(result, origin);
          if (!receipt) return result;
          if (e.id && !("content" in e || "files" in e || "edits" in e)) {
            // Settings-only calls create no version, so they add no shortcut;
            // a rename only updates the title of a row that already exists.
            await save($, session, origin, writes, (rows) =>
              retitle(rows, receipt.id, titleOf(e.title) || receipt.title),
            );
            $.ui.invalidate("ui.render");
            return result;
          }
          const now = await $.clock.now();
          await saveBoth($, session, origin, writes, (rows, deleted) => ({
            rows: applyPublish(rows, receipt, e.title, now),
            // A publish landing makes any kept deleted copy stale.
            deleted: deleted.some((a) => a.id === receipt.id)
              ? deleted.filter((a) => a.id !== receipt.id)
              : deleted,
          }));
        } else if (e.tool === deleteTool || e.tool === undeleteTool) {
          // Only a successful result counts, never the tool input.
          const gone = e.tool === deleteTool;
          const receipt = gone ? deletion(result) : undeletion(result);
          if (!receipt) return result;
          await saveBoth($, session, origin, writes, (rows, deleted) =>
            gone
              ? dropRow(rows, deleted, receipt.id)
              : reinstate(rows, deleted, receipt.id),
          );
        } else {
          const receipt = checked(result);
          if (!receipt) return result;
          const now = await $.clock.now();
          await save($, session, origin, writes, (rows) => {
            const old = rows.find((a) => a.id === receipt.id);
            if (
              !old ||
              receipt.version <
                Math.max(
                  old.publishedVersion,
                  old.lastCheckedCurrentVersion ?? 0,
                )
            )
              return rows;
            return rows.map((a) =>
              a.id === receipt.id
                ? {
                    ...a,
                    lastCheckedCurrentVersion: receipt.version,
                    lastCheckedAt: now,
                  }
                : a,
            );
          });
        }
        $.ui.invalidate("ui.render");
      } catch {
        /* Never repeat, replace or fail a tool because shortcut bookkeeping failed. */
      }
      return result;
    },
  );

  on("command.run", { command: "oa-artifacts" }, async ($) => {
    if (!origin || !validNamespace)
      return {
        text: "Configure this plugin's instanceUrl and mcpServer with /plugin configure before using artifact shortcuts.",
      };
    try {
      const session = await $.session.id();
      const rows = await load($, session, origin);
      if (session !== (await $.session.id()))
        return { text: "Session changed; run /oa-artifacts again." };
      return {
        text: rows.length
          ? rows
              .map((a) =>
                [
                  `${a.title} · published v${a.publishedVersion}`,
                  ...(a.lastCheckedAt !== null
                    ? [
                        `Last checked: v${a.lastCheckedCurrentVersion} at ${new Date(a.lastCheckedAt).toISOString()}`,
                      ]
                    : []),
                  a.url,
                ].join("\n"),
              )
              .join("\n\n")
          : "No artifact has been published in this session.",
      };
    } catch {
      return { text: "Artifact shortcuts are unavailable in this session." };
    }
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const props = record(e.props) ? e.props : {};
    if (
      !origin ||
      props.hasSurvey === true ||
      typeof props.maxRows !== "number" ||
      props.maxRows < 1
    )
      return next(e);
    let rows: Shortcut[];
    let session: string;
    try {
      session = await $.session.id();
      rows = await load($, session, origin);
      if (session !== (await $.session.id())) return next(e);
    } catch {
      return next(e);
    }
    if (!rows.length) return next(e);
    const previous = await next(e);
    try {
      if (session !== (await $.session.id())) return previous;
      const { Box, Text, Link } = $.ui.resolve(e);
      const columns =
        typeof props.bodyColumns === "number"
          ? Math.max(1, Math.floor(props.bodyColumns))
          : 80;
      const count = Math.min(3, Math.floor(props.maxRows), rows.length);
      return Box({
        flexDirection: "column",
        children: [
          ...rows.slice(0, count).map((a) => {
            const prefix = "↗ ";
            const suffix = ` v${a.publishedVersion}`;
            const dim = (text: string) =>
              Box({
                flexShrink: 0,
                children: [Text({ dimColor: true, children: [text] })],
              });
            // One column of slack: filling the last column can wrap or clip.
            const usable = columns - 1;
            const room = usable - 2 - cells(suffix);
            // Narrow: drop the title, then the prefix; the suffix stays whole.
            const children =
              room >= 1
                ? [
                    dim(prefix),
                    Box({
                      flexShrink: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      children: [
                        Link({ href: a.url, label: clip(a.title, room) }),
                      ],
                    }),
                    dim(suffix),
                  ]
                : usable >= 2 + cells(suffix)
                  ? [dim(prefix), dim(suffix)]
                  : [dim(suffix)];
            return Box({
              flexDirection: "row",
              width: columns,
              height: 1,
              overflow: "hidden",
              children,
            });
          }),
          ...(previous ? [previous] : []),
        ],
      });
    } catch {
      return previous;
    }
  });
}
