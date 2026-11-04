import { describe, expect, it } from "vitest";
import {
  decodeClientFrame,
  decodeServerFrame,
  encodeFrame,
  type Frame,
} from "../src/protocol.js";

const id = "7Yb3kQmZ1xRt9PvA";
const mid = "aaaaaaaaaaaaaaaa";

/** Each free-text field, as a builder taking the field value. Escapes arrive as `\udXXX` in JSON. */
type Case = {
  name: string;
  side: "client" | "server";
  frame: (v: string) => Record<string, unknown>;
};
const cases: Case[] = [
  {
    name: "send.body",
    side: "client",
    frame: (v) => ({ type: "send", from_ref: "s1", to_name: "a", body: v }),
  },
  {
    name: "send.to_name",
    side: "client",
    frame: (v) => ({ type: "send", from_ref: "s1", to_name: v, body: "x" }),
  },
  {
    name: "hello.machine_label",
    side: "client",
    frame: (v) => ({ type: "hello", machine_label: v, client_version: "1" }),
  },
  {
    name: "hello.client_version",
    side: "client",
    frame: (v) => ({ type: "hello", machine_label: "M", client_version: v }),
  },
  {
    name: "agent_up.proposed_name",
    side: "client",
    frame: (v) => ({
      type: "agent_up",
      agent_ref: "s1",
      kind: "claude-code",
      proposed_name: v,
      namespace: "a/b",
      global: false,
    }),
  },
  {
    name: "deliver.body",
    side: "server",
    frame: (v) => ({
      type: "deliver",
      msg_id: mid,
      to_ref: "s1",
      from_name: "Pi",
      namespace: "a/b",
      body: v,
    }),
  },
  {
    name: "deliver.from_name",
    side: "server",
    frame: (v) => ({
      type: "deliver",
      msg_id: mid,
      to_ref: "s1",
      from_name: v,
      namespace: "a/b",
      body: "x",
    }),
  },
  {
    name: "body.body",
    side: "server",
    frame: (v) => ({ type: "body", msg_id: mid, body: v }),
  },
  {
    name: "error.message",
    side: "server",
    frame: (v) => ({ type: "error", code: "bad_frame", message: v }),
  },
  {
    name: "hello_ok.server_version",
    side: "server",
    frame: (v) => ({
      type: "hello_ok",
      machine_id: "7Yb3kQmZ1xRt9PvA",
      machine_label: "M",
      server_version: v,
    }),
  },
  {
    name: "hello_ok.machine_label",
    side: "server",
    frame: (v) => ({
      type: "hello_ok",
      machine_id: "7Yb3kQmZ1xRt9PvA",
      machine_label: v,
      server_version: "1",
    }),
  },
  {
    name: "agent_ok.bus_name",
    side: "server",
    frame: (v) => ({
      type: "agent_ok",
      agent_ref: "s1",
      bus_name: v,
    }),
  },
];

const decode = (c: Case, raw: string) =>
  c.side === "client" ? decodeClientFrame(raw) : decodeServerFrame(raw);
const rawWith = (c: Case, escaped: string): string => {
  // Build JSON text by hand so the surrogate stays a `\ud800` escape.
  const json = JSON.stringify({ v: 1, id, ...c.frame("@@") });
  return json.replace("@@", escaped);
};

const BAD: [string, string][] = [
  ["lone high surrogate", "a\\ud800b"],
  ["lone low surrogate", "a\\udc00b"],
  ["reversed pair", "a\\udc00\\ud800b"],
  ["trailing high surrogate", "a\\ud83d"],
];

describe("well-formed Unicode in frames", () => {
  for (const c of cases) {
    describe(c.name, () => {
      for (const [label, esc] of BAD) {
        it(`rejects ${label} (JSON escape)`, () => {
          const r = decode(c, rawWith(c, esc));
          expect(r.ok).toBe(false);
          if (!r.ok) {
            expect(r.error).toBe("bad_frame");
            expect(r.id).toBe(id);
          }
        });
      }
      it("rejects a lone surrogate sent as raw string value", () => {
        const f = { v: 1, id, ...c.frame("a\ud800b") };
        expect(() => encodeFrame(f as Frame)).toThrow(RangeError);
      });
    });
  }

  it("still accepts a valid surrogate pair (emoji) in free text", () => {
    const free = cases.filter((c) =>
      [
        "send.body",
        "hello.client_version",
        "agent_up.proposed_name",
        "deliver.body",
        "body.body",
        "error.message",
        "hello_ok.server_version",
      ].includes(c.name),
    );
    for (const c of free) {
      expect(decode(c, rawWith(c, "hi \\ud83d\\ude00!")).ok, c.name).toBe(true);
      const f = { v: 1, id, ...c.frame("hi \u{1F600}!") } as Frame;
      expect(decode(c, encodeFrame(f)).ok, c.name).toBe(true);
    }
  });

  it("encodeFrame throws RangeError on a lone surrogate and does not mangle valid text", () => {
    const f = {
      v: 1,
      id,
      type: "send",
      from_ref: "s1",
      to_name: "a",
      body: "x\ud800",
    } as Frame;
    expect(() => encodeFrame(f)).toThrow(RangeError);
  });
});
