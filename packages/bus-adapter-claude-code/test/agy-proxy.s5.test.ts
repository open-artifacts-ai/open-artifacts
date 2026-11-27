// agy S5: Antigravity's calls prove which agy session made them on the
// instance's /mcp. agy runs one proxy per agy process for all its
// conversations; each tools/call names its conversation in `_meta`. The proxy
// asks the daemon to bind that conversation's proof, and adds the header only
// when it did. No sleeps: every wait is a promise the fakes resolve.
import { createHash } from "node:crypto";
import { LINK_PROOF_HEADER } from "@oa/bus-ipc";
import { describe, expect, it } from "vitest";
import {
  AGY_CONVERSATION_META,
  AGY_ROOT_META,
  AgyProxy,
  agyConversation,
} from "../src/agy-proxy.ts";
import { findAgy } from "../src/agy-proxy-main.ts";

const INSTANCE = "https://oa.example.com";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const PROOF_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const CA = "de77814a-7977-4ceb-b099-379ea43f490c";
const CB = "700e7cae-1111-4ceb-b099-379ea43f490c";

/** What agy 1.5.17 sends in a tools/call's `_meta` (captured live). */
const meta = (conv: string, root = conv) => ({
  "antigravity.google/artifacts_dir": `/Users/x/.gemini/antigravity-cli/brain/${conv}`,
  [AGY_CONVERSATION_META]: conv,
  [AGY_ROOT_META]: root,
  progressToken: "p:2",
});

type Link = {
  pid: number;
  conversation: string;
  hash: string;
  instance?: string;
};

function setup(
  over: {
    bound?: (l: Link) => boolean | Error;
    agyPid?: () => number | undefined;
    instanceName?: string;
    link?: (l: Link) => Promise<boolean>;
    linkMs?: number;
  } = {},
) {
  const links: Link[] = [];
  const seen: { headers: Headers; body: string }[] = [];
  const proxy = new AgyProxy({
    instance: INSTANCE,
    ...(over.instanceName ? { instanceName: over.instanceName } : {}),
    token: () => "oa_pat_TOKEN",
    agyPid: over.agyPid ?? (() => 777),
    link:
      over.link ??
      (async (l) => {
        links.push(l);
        const b = over.bound?.(l) ?? true;
        if (b instanceof Error) throw b;
        return b;
      }),
    ...(over.linkMs ? { linkMs: over.linkMs } : {}),
    fetch: (async (_url: URL, init: RequestInit) => {
      seen.push({
        headers: new Headers(init.headers),
        body: String(init.body),
      });
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }),
        { headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch,
  });
  const call = (m: unknown) =>
    proxy.call({ name: "publish_artifact", arguments: {}, _meta: m });
  const proofOf = (i: number) => seen[i]?.headers.get(LINK_PROOF_HEADER);
  return { proxy, links, seen, call, proofOf };
}

describe("AgyProxy (agy S5)", () => {
  it("adds the conversation's proof once the daemon bound its hash to that agy pid", async () => {
    const s = setup();
    await s.call(meta(CA));
    expect(s.links).toHaveLength(1);
    expect(s.links[0]).toMatchObject({ pid: 777, conversation: CA });
    expect(s.links[0]).not.toHaveProperty("instance");
    const p = s.proofOf(0) as string;
    expect(p).toMatch(PROOF_SHAPE);
    expect(s.links[0]?.hash).toBe(sha(p));
    expect(s.seen[0]?.headers.get("authorization")).toBe("Bearer oa_pat_TOKEN");
  });

  it("keeps one proof per conversation, asked again on every call", async () => {
    const s = setup();
    await s.call(meta(CA));
    await s.call(meta(CB));
    await s.call(meta(CA));
    expect(s.links.map((l) => l.conversation)).toEqual([CA, CB, CA]);
    expect(s.proofOf(0)).toBe(s.proofOf(2));
    expect(s.proofOf(0)).not.toBe(s.proofOf(1));
  });

  it("a subagent's call is its root conversation's", async () => {
    const s = setup();
    await s.call(meta("sub-1", CA));
    expect(s.links[0]?.conversation).toBe(CA);
    expect(agyConversation({ [AGY_CONVERSATION_META]: CB })).toBe(CB);
    expect(agyConversation({ [AGY_CONVERSATION_META]: "bad id!" })).toBe(
      undefined,
    );
  });

  it("names an added instance on the bind", async () => {
    const s = setup({ instanceName: "mit-ai" });
    await s.call(meta(CA));
    expect(s.links[0]?.instance).toBe("mit-ai");
  });

  it("goes unlinked but works: no _meta, no agy parent, not bound, daemon down, or too slow", async () => {
    const none = setup();
    await none.call(undefined);
    expect(none.links).toHaveLength(0);
    expect(none.proofOf(0)).toBeNull();
    for (const over of [
      { agyPid: () => undefined },
      { bound: () => false },
      { bound: () => new Error("ECONNREFUSED") },
      { link: () => new Promise<boolean>(() => {}), linkMs: 5 },
    ]) {
      const s = setup(over);
      await s.call(meta(CA));
      expect(s.seen).toHaveLength(1);
      expect(s.proofOf(0)).toBeNull();
    }
  });

  it("never puts the proof in the body", async () => {
    const s = setup();
    await s.call(meta(CA));
    expect(s.seen[0]?.body).not.toContain(s.proofOf(0) as string);
  });
});

describe("findAgy", () => {
  const table: Record<number, { ppid: number; name: string }> = {
    30: { ppid: 20, name: "node" },
    20: { ppid: 10, name: "sh" },
    10: { ppid: 1, name: "agy" },
  };
  it("walks up from the proxy to the agy process", () => {
    expect(findAgy(30, (p) => table[p] ?? null)).toBe(10);
  });
  it("is undefined with no agy above, or an unreadable process", () => {
    expect(findAgy(30, (p) => (p === 10 ? null : (table[p] ?? null)))).toBe(
      undefined,
    );
    expect(
      findAgy(30, (p) =>
        table[p] ? { ...(table[p] as { ppid: number }), name: "zsh" } : null,
      ),
    ).toBe(undefined);
  });
});
