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
  type Shortcut,
  undeletion,
} from "./model.ts";

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
      await $.store.set(deletedKey(origin, session), next.deleted);
      await $.store.set(k, next.rows);
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
          // Settings-only calls create no version, so they are not a publish shortcut.
          if (e.id && !("content" in e || "files" in e || "edits" in e))
            return result;
          const receipt = published(result, origin);
          if (!receipt) return result;
          const now = await $.clock.now();
          await save($, session, origin, writes, (rows) =>
            applyPublish(rows, receipt, e.title, now),
          );
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
                    : ["Current version not checked."]),
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
            const prefix = `Published v${a.publishedVersion} · `;
            const length = Math.max(1, columns - prefix.length - 1);
            const title = Array.from(a.title);
            const label =
              title.length > length
                ? `${title.slice(0, Math.max(0, length - 1)).join("")}…`
                : a.title;
            return Box({
              flexDirection: "row",
              width: columns,
              height: 1,
              overflow: "hidden",
              children: [
                Text({ children: [prefix] }),
                Link({ href: a.url, label }),
              ],
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
