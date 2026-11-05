import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FakeInstall } from "./fake.ts";

// A stand-in for the migration skill (Backend scope C, not on main yet). It
// parses the export on its own (never through src/check.ts) and publishes
// into the fake with the contract's semantics: one artifact per
// (owner, importKey); same content is a no-op; changed content adds one
// version. `bugs` makes it misbehave the ways the checker must catch.

const TYPES = new Set([
  "text/html",
  "text/markdown",
  "application/vnd.ant.code",
  "application/vnd.ant.react",
  "application/vnd.ant.mermaid",
  "image/svg+xml",
]);

export interface Bugs {
  /** Always create a new artifact, even when the importKey exists. */
  duplicate?: boolean;
  /** Add a version even when the content is unchanged. */
  versionUnchanged?: boolean;
  /** Changed content adds two versions instead of one. */
  doubleVersion?: boolean;
  /** importKey -> space id to publish to instead of the mapped one. */
  wrongSpace?: Record<string, string>;
  /** importKey -> user id to publish as instead of the owner. */
  wrongOwner?: Record<string, string>;
  /** importKeys left out. */
  skip?: string[];
}

interface Item {
  conv: string;
  type: string;
  content: string;
}

function items(dir: string): Map<string, Item> {
  const convs = JSON.parse(
    readFileSync(join(dir, "conversations.json"), "utf8"),
  );
  const out = new Map<string, Item>();
  for (const c of convs)
    for (const m of c.chat_messages)
      for (const part of m.content) {
        if (part.type !== "tool_use" || part.name !== "artifacts") continue;
        const i = part.input;
        const key = `claude:${c.uuid}:${i.id}`;
        const cur = out.get(key);
        if (i.command === "create" || i.command === "rewrite")
          out.set(key, {
            conv: c.uuid,
            type: i.type ?? cur?.type,
            content: i.content,
          });
        else if (i.command === "update" && cur)
          cur.content = cur.content.replace(i.old_str, i.new_str);
      }
  return out;
}

export function runSkill(
  fake: FakeInstall,
  o: {
    exportDir: string;
    ownerId: string;
    spaceMap: Record<string, string>;
    bugs?: Bugs;
  },
): void {
  const bugs = o.bugs ?? {};
  for (const [key, it] of items(o.exportDir)) {
    if (!TYPES.has(it.type) || bugs.skip?.includes(key)) continue;
    const ownerId = bugs.wrongOwner?.[key] ?? o.ownerId;
    const spaceId =
      bugs.wrongSpace?.[key] ??
      o.spaceMap[it.conv] ??
      o.spaceMap["*"] ??
      o.ownerId;
    const files = {
      [it.type === "text/markdown" ? "README.md" : "index.html"]: it.content,
    };
    const existing = fake.artifacts.find(
      (a) => a.ownerId === ownerId && a.importKey === key,
    );
    if (!existing || bugs.duplicate) {
      fake.create({ ownerId, spaceId, importKey: key, files });
      continue;
    }
    const last = existing.versions[existing.versions.length - 1];
    const same = JSON.stringify(last.files) === JSON.stringify(files);
    if (same && !bugs.versionUnchanged) continue;
    fake.addVersion(existing.id, files);
    if (!same && bugs.doubleVersion) fake.addVersion(existing.id, files);
  }
}
