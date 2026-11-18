// #2688: a successful write by an agent that isn't linked to its bus session
// carries one plain line saying so, with the fix step. Never a read, never a
// failed write, never a person's session, and it can't fail the write.
import {
  BUS_CAPS,
  type ClientFrame,
  LINK_PROOF_HEADER,
} from "@oa/bus-protocol";
import { newId } from "@oa/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPat } from "../../src/auth/pat.js";
import { createServer } from "../../src/mcp/server.js";
import { unlinkedNote } from "../../src/mcp/unlinked-note.js";
import type { UnlinkedWhy } from "../../src/services/agent-usage.js";
import { getUser } from "../../src/services/users.js";
import { sha256Hex } from "../../src/util/crypto.js";
import { close, connect, textOf, tool } from "../mcp-helpers.js";
import {
  daemon,
  e,
  hello,
  machine,
  member,
  ns,
  up,
  waitFor,
} from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

let seq = 0;
const proofOf = () =>
  `${"p".repeat(11)}${crypto.randomUUID().replaceAll("-", "")}`;
const NOTE = /isn't linked to its bus session/;

/** A member with a connected machine; with `proof`, one agent bound to it. */
async function withMachine(proof?: string) {
  const m = await member();
  const mach = await machine("Laptop", m.userId);
  if (proof) {
    const d = await daemon(mach.token);
    d.send({ ...hello(`h${++seq}`), caps: [BUS_CAPS.link] } as ClientFrame);
    await waitFor(d, "hello_ok");
    d.send(up(`u${++seq}`, `ref${seq}`, `Lead${seq}`, ns("note")));
    await waitFor(d, "agent_ok");
    d.send({
      v: 1,
      id: `b${++seq}`,
      type: "link_bind",
      agent_ref: `ref${seq - 1}`,
      hash: await sha256Hex(proof),
    } as never);
    await waitFor(d, "link_bound");
  }
  return m;
}

const publishArgs = (title: string) => ({
  title,
  format: "markdown",
  content: "x",
});

async function clientFor(userId: string, proof?: string) {
  const pat = await createPat(e, userId, "agent");
  return connect(pat.token, {
    env: e,
    ...(proof === undefined ? {} : { headers: { [LINK_PROOF_HEADER]: proof } }),
  });
}

describe("through /mcp", () => {
  it("no proof sent: publish and add_comment carry the note, a read does not", async () => {
    // A member whose machine has connected, whose agent here sends no proof.
    const m = await withMachine(proofOf());
    const c = await clientFor(m.userId);
    try {
      const pub = await tool(c, "publish_artifact", publishArgs("A"));
      expect(pub.isError).toBeFalsy();
      expect(textOf(pub)).toMatch(NOTE);
      expect(textOf(pub)).toContain("this connection sent no link proof");
      expect(textOf(pub)).toContain(
        "Tell your person: reconnect the Open Artifacts connection",
      );
      const id = (pub.structuredContent as { id: string }).id;
      const com = await tool(c, "add_comment", { id, body: "hi" });
      expect(com.isError).toBeFalsy();
      expect(textOf(com)).toMatch(NOTE);
      // An ask is a write too.
      const ask = await tool(c, "add_comment", {
        id,
        body: "Which?",
        ask: {
          question: "Which?",
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
          to: [],
        },
      });
      if (!ask.isError) expect(textOf(ask)).toMatch(NOTE);
      for (const read of [
        ["list_comments", { id }],
        ["get_artifact", { id }],
      ] as const) {
        const r = await tool(c, read[0], read[1] as Record<string, unknown>);
        expect(textOf(r), read[0]).not.toMatch(NOTE);
      }
    } finally {
      await close(c);
    }
  });

  it("a proof no session holds reads unbound; a mangled one reads malformed", async () => {
    const m = await withMachine(proofOf());
    const unbound = await clientFor(m.userId, proofOf());
    const bad = await clientFor(m.userId, "garbage");
    try {
      const a = await tool(unbound, "publish_artifact", publishArgs("U"));
      expect(textOf(a)).toContain(
        "no bus session holds this connection's proof",
      );
      const b = await tool(bad, "publish_artifact", publishArgs("M"));
      expect(textOf(b)).toContain("its link proof was malformed");
    } finally {
      await close(unbound);
      await close(bad);
    }
  });

  it("a linked agent gets no note", async () => {
    const proof = proofOf();
    const m = await withMachine(proof);
    const c = await clientFor(m.userId, proof);
    try {
      const r = await tool(c, "publish_artifact", publishArgs("L"));
      expect(r.isError).toBeFalsy();
      expect(textOf(r)).not.toMatch(NOTE);
    } finally {
      await close(c);
    }
  });

  it("a member who never connected a bus machine gets no note, proof or not", async () => {
    const m = await member();
    const none = await clientFor(m.userId, proofOf());
    try {
      const r = await tool(none, "publish_artifact", publishArgs("N"));
      expect(r.isError).toBeFalsy();
      expect(textOf(r)).not.toMatch(NOTE);
    } finally {
      await close(none);
    }
  });

  it("no proof sent by a member with no bus machine: no note (nothing to link)", async () => {
    const m = await member();
    const c = await clientFor(m.userId);
    try {
      const r = await tool(c, "publish_artifact", publishArgs("NM"));
      expect(r.isError).toBeFalsy();
      expect(textOf(r)).not.toMatch(NOTE);
    } finally {
      await close(c);
    }
  });

  it("a failed write carries no note", async () => {
    const m = await withMachine();
    const c = await clientFor(m.userId);
    try {
      const r = await tool(c, "add_comment", {
        id: "no-such-artifact",
        body: "x",
      });
      expect(r.isError).toBe(true);
      expect(textOf(r)).not.toMatch(NOTE);
    } finally {
      await close(c);
    }
  });
});

describe("the note's table", () => {
  const lead = (reason: string) =>
    `This agent isn't linked to its bus session (${reason}), so answers to its asks won't reach it.`;
  const FULL =
    "You can run `oa-bus doctor` to check. Tell your person: reconnect the Open Artifacts connection (in Claude Code: /mcp, then Reconnect). If it stays unlinked, run `oa-bus install` again and restart this session.";
  const RETRY =
    "It may clear on the next write. You can run `oa-bus doctor` to check.";
  const exact: [UnlinkedWhy, string][] = [
    ["no_proof", `${lead("this connection sent no link proof")} ${FULL}`],
    [
      "unbound",
      `${lead("no bus session holds this connection's proof")} ${FULL}`,
    ],
    ["malformed", `${lead("its link proof was malformed")} ${FULL}`],
    ["other", `${lead("its session isn't ready")} ${FULL}`],
    [
      "closed",
      `${lead("its bus session is closed")} You can run \`oa-bus doctor\` to check. Tell your person: restart this session.`,
    ],
    [
      "unlinked",
      `${lead("its bus session has no identity")} You can run \`oa-bus doctor\` to check. Tell your person: run \`oa-bus install\` again and restart this session.`,
    ],
    [
      "revoked",
      `${lead("this computer's approval was revoked")} Tell your person: run \`oa-bus install\` to approve this computer again, then restart this session.`,
    ],
    ["no_hub", `${lead("the bus couldn't be reached")} ${RETRY}`],
    ["timeout", `${lead("the link check timed out")} ${RETRY}`],
    ["error", `${lead("the link check failed")} ${RETRY}`],
  ];
  it.each(exact)("%s is exactly the agreed line", (why, line) => {
    expect(unlinkedNote(why)).toBe(line);
  });
  it("an agent is only ever told to check; install and restart are for its person", () => {
    for (const [why] of exact) {
      const n = unlinkedNote(why) as string;
      expect(n).not.toMatch(/[0-9a-f]{16,}/);
      expect(n).not.toContain("\n");
      expect(n).not.toContain("—");
      const [before] = n.split("Tell your person");
      expect(before).not.toMatch(/install|restart/i);
    }
  });
  it("no_machine and nothing say nothing", () => {
    expect(unlinkedNote("no_machine")).toBeNull();
    expect(unlinkedNote(undefined)).toBeNull();
  });
});

describe("the wrapper", () => {
  type Run = (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ isError?: boolean; content: { text: string }[] }>;
  async function server(agent: unknown) {
    const m = await member();
    const user = (await getUser(e, m.userId))!;
    const s = createServer({
      env: e,
      user,
      sessionEpoch: 0,
      agent: agent as never,
    });
    const d = s as unknown as {
      _registeredTools: Record<string, unknown>;
      executeToolHandler: (
        t: unknown,
        a: unknown,
        c: unknown,
      ) => Promise<never>;
    };
    const run: Run = (name, args) =>
      d.executeToolHandler(d._registeredTools[name], args, {}) as never;
    return run;
  }
  const texts = (r: { content: { text: string }[] }) =>
    r.content.map((c) => c.text).join("\n");

  it("each write tool carries the note for an unlinked agent; reads and a person's session do not", async () => {
    const run = await server({ name: "A", version: null, unlinked: "closed" });
    const pub = await run("publish_artifact", publishArgs("W"));
    expect(texts(pub)).toContain(
      "its bus session is closed), so answers to its asks won't reach it.",
    );
    const id = JSON.parse(JSON.stringify(pub)).structuredContent.id as string;
    expect(texts(await run("add_comment", { id, body: "c" }))).toMatch(NOTE);
    expect(texts(await run("list_comments", { id }))).not.toMatch(NOTE);
    // A person's own session has no agent at all; a linked or unreasoned one no `unlinked`.
    for (const agent of [null, { name: "A", version: null }]) {
      const r = await server(agent);
      const p = await r("publish_artifact", publishArgs("P"));
      expect(p.isError).toBeFalsy();
      expect(texts(p)).not.toMatch(NOTE);
    }
  });

  it("the data writes carry it too", async () => {
    const run = await server({
      name: "A",
      version: null,
      unlinked: "unlinked",
    });
    const pub = await run("publish_artifact", publishArgs("D"));
    const id = JSON.parse(JSON.stringify(pub)).structuredContent.id as string;
    for (const [name, args] of [
      ["artifact_data_set", { id, collection: "c", key: "k", value: { a: 1 } }],
      [
        "artifact_data_update",
        { id, collection: "c", key: "k", patch: { a: 2 } },
      ],
      ["artifact_data_delete", { id, collection: "c", key: "k" }],
    ] as const) {
      const r = await run(name, args as Record<string, unknown>);
      // A write that succeeds gets the note; one the tool refuses does not.
      if (!r.isError) expect(texts(r), name).toMatch(NOTE);
      else expect(texts(r), name).not.toMatch(NOTE);
    }
  });

  it("a write still succeeds when building the note throws", async () => {
    const hostile = new Proxy(
      { name: "A", version: null },
      {
        get(t, k) {
          if (k === "unlinked") throw new Error("boom");
          return Reflect.get(t, k);
        },
      },
    );
    const run = await server(hostile);
    const r = await run("publish_artifact", publishArgs("H"));
    expect(r.isError).toBeFalsy();
    expect(texts(r)).toMatch(/Published|Created|artifact/i);
    expect(texts(r)).not.toMatch(NOTE);
  });
});
