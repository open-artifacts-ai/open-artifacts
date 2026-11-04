// Renames (#393, OpenBus R393a): rename/renamed frames, roster former_names,
// name_kind, the limits, and the hello `caps` the hub gates them on.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BUS_CAPS, CapsSchema, hasCap, MAX_CAPS } from "../src/caps.ts";
import { KindTokenSchema } from "../src/kinds.ts";
import { LIMITS } from "../src/limits.ts";
import { BusNameSchema } from "../src/names.ts";
import { WireNamespaceSchema } from "../src/namespace.ts";
import {
  CLIENT_FRAMES,
  decodeClientFrame,
  decodeServerFrame,
  encodeFrame,
  SERVER_FRAMES,
} from "../src/protocol.ts";
import { MachineLabelSchema } from "../src/refs.ts";
import {
  FormerNamesSchema,
  NAME_KINDS,
  RENAME_MESSAGES,
} from "../src/rename.ts";
import {
  IsoTimeSchema,
  StatusLabelSchema,
  StatusStateSchema,
} from "../src/status.ts";

const id = "7Yb3kQmZ1xRt9PvA";
const at = (h: number) => new Date(Date.UTC(2026, 10, 4, h)).toISOString();
const row = (former_names?: unknown) => ({
  bus_name: "beta",
  kind: "pi",
  namespace: "ns",
  global: false,
  state: "live",
  ...(former_names === undefined ? {} : { former_names }),
});
const roster = (agents: unknown[]) =>
  JSON.stringify({ v: 1, id, type: "roster", agents });

describe("limits (R393a)", () => {
  it("pins the grace, the roster cap and the rate", () => {
    expect(LIMITS.formerNameGraceMs).toBe(3_600_000);
    expect(LIMITS.formerNameGraceMs).toBe(LIMITS.mailTtlSec * 1000);
    expect(LIMITS.maxFormerNames).toBe(5);
    expect(LIMITS.renamesPerHour).toBe(10);
    expect(RENAME_MESSAGES).toEqual({
      rate: "Too many renames",
      room: "Too many recent names",
    });
  });
});

describe("hello caps", () => {
  const hello = {
    v: 1,
    id,
    type: "hello",
    machine_label: "Leo-Workstation",
    client_version: "0.0.0",
  } as const;
  const dec = (caps: unknown) =>
    decodeClientFrame(JSON.stringify({ ...hello, caps }));

  it("parses without caps, unchanged", () => {
    expect(decodeClientFrame(encodeFrame(hello))).toEqual({
      ok: true,
      frame: hello,
    });
  });

  it("round-trips caps, including unknown tokens", () => {
    const f = { ...hello, caps: ["rename", "future_thing", "x-1"] };
    expect(decodeClientFrame(encodeFrame(f))).toEqual({ ok: true, frame: f });
    expect(dec([]).ok).toBe(true);
    const full = Array.from({ length: MAX_CAPS }, (_, i) => `c${i}`);
    expect(dec(full).ok).toBe(true);
    expect(dec(["a".repeat(32)]).ok).toBe(true);
  });

  it("rejects oversized, malformed and duplicate caps", () => {
    const bad: unknown[] = [
      Array.from({ length: MAX_CAPS + 1 }, (_, i) => `c${i}`),
      ["a".repeat(33)],
      ["Rename"],
      ["1rename"],
      ["re name"],
      [""],
      [1],
      ["rename", "rename"],
      "rename",
      null,
    ];
    for (const b of bad) {
      expect(dec(b).ok, JSON.stringify(b)).toBe(false);
      expect(CapsSchema.safeParse(b).success, JSON.stringify(b)).toBe(false);
    }
  });

  it("hasCap reads the hello", () => {
    expect(BUS_CAPS).toEqual({ rename: "rename", roles: "roles" });
    expect(hasCap({ caps: ["x", "rename"] }, BUS_CAPS.rename)).toBe(true);
    expect(hasCap({ caps: ["x"] }, BUS_CAPS.rename)).toBe(false);
    expect(hasCap({}, BUS_CAPS.rename)).toBe(false);
    expect(hasCap(null, BUS_CAPS.rename)).toBe(false);
    const r = decodeClientFrame(JSON.stringify({ ...hello, caps: ["rename"] }));
    expect(r.ok && r.frame.type === "hello" && hasCap(r.frame, "rename")).toBe(
      true,
    );
  });

  it("is a client frame only", () => {
    expect(
      decodeServerFrame(JSON.stringify({ ...hello, caps: ["rename"] })).ok,
    ).toBe(false);
  });
});

describe("rename / renamed frames (R393a)", () => {
  const rename = {
    v: 1,
    id,
    type: "rename",
    agent_ref: "s1",
    proposed_name: "OA Backend",
  } as const;

  it("lists both frames", () => {
    expect(CLIENT_FRAMES).toContain("rename");
    expect(SERVER_FRAMES).toContain("renamed");
  });

  it("round-trips rename (client) and renamed (server)", () => {
    expect(decodeClientFrame(encodeFrame(rename))).toEqual({
      ok: true,
      frame: rename,
    });
    const renamed = {
      v: 1,
      id,
      type: "renamed",
      agent_ref: "s1",
      bus_name: "OA Backend",
      former: "agent-2",
    } as const;
    expect(decodeServerFrame(encodeFrame(renamed))).toEqual({
      ok: true,
      frame: renamed,
    });
    // Each decoder accepts only its own direction.
    expect(decodeServerFrame(encodeFrame(rename)).ok).toBe(false);
    expect(decodeClientFrame(encodeFrame(renamed)).ok).toBe(false);
  });

  it("parses renamed without former (a no-op)", () => {
    const f = { v: 1, id, type: "renamed", agent_ref: "s1", bus_name: "a" };
    expect(decodeServerFrame(JSON.stringify(f)).ok).toBe(true);
  });

  it("decodes a case-only rename (Beta -> beta)", () => {
    const f = {
      v: 1,
      id,
      type: "renamed",
      agent_ref: "s1",
      bus_name: "beta",
      former: "Beta",
    };
    expect(decodeServerFrame(JSON.stringify(f)).ok).toBe(true);
  });

  it("bounds proposed_name like agent_up, and rejects an empty or extra field", () => {
    const enc = (o: object) => JSON.stringify({ ...rename, ...o });
    expect(decodeClientFrame(enc({ proposed_name: "x".repeat(256) })).ok).toBe(
      true,
    );
    expect(decodeClientFrame(enc({ proposed_name: "x".repeat(257) })).ok).toBe(
      false,
    );
    expect(decodeClientFrame(enc({ proposed_name: "" })).ok).toBe(false);
    expect(decodeClientFrame(enc({ proposed_name: "\ud800" })).ok).toBe(false);
    expect(decodeClientFrame(enc({ name: "x" })).ok).toBe(false);
  });
});

describe("roster former_names (R393a)", () => {
  const five = [5, 4, 3, 2, 1].map((h, i) => ({
    name: `old-${i}`,
    expires_at: at(h),
  }));

  it("round-trips up to 5, newest first", () => {
    const r = decodeServerFrame(roster([row(five)]));
    expect(r.ok).toBe(true);
    expect(r.ok && r.frame.type === "roster" && r.frame.agents[0]).toEqual(
      row(five),
    );
    expect(FormerNamesSchema.parse(five)).toEqual(five);
  });

  it("is optional: a row without it still parses", () => {
    expect(decodeServerFrame(roster([row()])).ok).toBe(true);
  });

  it("rejects over 5 former names", () => {
    const six = [...five, { name: "old-5", expires_at: at(0) }];
    expect(decodeServerFrame(roster([row(six)])).ok).toBe(false);
    expect(FormerNamesSchema.safeParse(six).success).toBe(false);
  });

  it("rejects malformed entries", () => {
    const bad: unknown[] = [
      [{ name: "open-artifacts", expires_at: at(1) }], // reserved
      [{ name: "a", expires_at: "soon" }],
      [{ name: "a", expires_at: at(1), extra: 1 }],
      [{ name: "a" }],
      [],
    ];
    for (const b of bad)
      expect(decodeServerFrame(roster([row(b)])).ok, JSON.stringify(b)).toBe(
        false,
      );
  });

  it("leaves hub invariants to the hub: one bad row never fails a roster", () => {
    // Order, case-insensitive distinctness and != bus_name are pinned by the
    // hub's tests (R393b), not the decoder.
    const lax: unknown[] = [
      [five[1], five[0]], // oldest first
      [five[0], { ...five[1], name: "OLD-0" }], // duplicate ignoring case
      [{ name: "Beta", expires_at: at(1) }], // the row's bus_name, other case
    ];
    for (const b of lax)
      expect(
        decodeServerFrame(roster([row(), row(b)])).ok,
        JSON.stringify(b),
      ).toBe(true);
  });

  it("receipts carry a former-name to_name", () => {
    const f = {
      v: 1,
      id,
      type: "receipt",
      msg_id: id,
      state: "pending",
      to_name: "OA Backend",
    };
    expect(decodeServerFrame(JSON.stringify(f))).toEqual({
      ok: true,
      frame: f,
    });
  });
});

/**
 * The pre-R393a decoder, frozen: the strict roster row and hello from
 * `@oa/bus-protocol` before this change. It rejects a row with
 * `former_names` (failing the whole roster), which is why the hub sends it
 * only to a socket whose hello listed `BUS_CAPS.rename`. It also rejects a
 * hello with `caps`, so a client sends caps only to hubs that accept them.
 */
describe("the frozen pre-R393a decoder rejects the new fields (why the hub gates)", () => {
  const OldRow = z.strictObject({
    bus_name: BusNameSchema,
    kind: KindTokenSchema,
    namespace: WireNamespaceSchema,
    global: z.boolean(),
    state: z.enum(["live", "queued"]),
    machine_label: MachineLabelSchema.optional(),
    status: StatusStateSchema.optional(),
    status_label: StatusLabelSchema.optional(),
    status_at: IsoTimeSchema.optional(),
  });
  const OldRoster = z.strictObject({
    v: z.literal(1),
    id: z.string(),
    type: z.literal("roster"),
    agents: z.array(OldRow),
  });
  const OldHello = z.strictObject({
    v: z.literal(1),
    id: z.string(),
    type: z.literal("hello"),
    machine_label: MachineLabelSchema,
    client_version: z.string().min(1).max(64),
  });

  it("rejects a roster with one former_names row, and takes one without", () => {
    const names = [{ name: "alpha", expires_at: at(1) }];
    const parse = (agents: unknown[]) =>
      OldRoster.safeParse(JSON.parse(roster(agents))).success;
    expect(parse([row(), row(names)])).toBe(false);
    expect(parse([row(), row()])).toBe(true);
  });

  it("rejects a hello with caps, and takes one without", () => {
    const h = {
      v: 1,
      id,
      type: "hello",
      machine_label: "m",
      client_version: "0.0.0",
    };
    expect(OldHello.safeParse({ ...h, caps: ["rename"] }).success).toBe(false);
    expect(OldHello.safeParse(h).success).toBe(true);
  });
});

describe("decoder bounds for former_names (R393a)", () => {
  const worst = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      bus_name: `agent-${i}-${"x".repeat(40)}`,
      kind: "claude-code",
      namespace: "github.com/open-artifacts-ai/open-artifacts",
      global: false,
      state: "queued",
      machine_label: "Leo-Workstation",
      status: "waiting_on_owner",
      status_label: "x".repeat(64),
      status_at: at(1),
      former_names: [5, 4, 3, 2, 1].map((h, j) => ({
        name: `old-${i}-${j}`,
        expires_at: at(h),
      })),
    }));

  it("a full roster of worst-case rows decodes on the client side", () => {
    const r = decodeServerFrame(roster(worst(LIMITS.maxRosterAgents)));
    expect(r.ok).toBe(true);
  });

  it("the server-frame decoder allows depth 5 but not 6", () => {
    const f = (x: string) =>
      `{"v":1,"id":"${id}","type":"roster_changed","namespace":"a","x":${x}}`;
    // The pre-scan refuses without recovering the id; the schema (strict,
    // no `x`) refuses with it. So depth 5 reaches the schema, depth 6 doesn't.
    expect(decodeServerFrame(f("[[[[]]]]"))).toEqual({
      ok: false,
      error: "bad_frame",
      id,
    });
    expect(decodeServerFrame(f("[[[[[]]]]]"))).toEqual({
      ok: false,
      error: "bad_frame",
    });
  });

  it("the hub-side client decoder keeps depth 4", () => {
    // A rename never nests; a depth-5 client frame is refused before parse.
    const ok = `{"v":1,"id":"${id}","type":"ack","x":[[[]]]}`;
    const deep = `{"v":1,"id":"${id}","type":"ack","x":[[[[]]]]}`;
    expect(decodeClientFrame(ok)).toEqual({
      ok: false,
      error: "bad_frame",
      id,
    });
    expect(decodeClientFrame(deep)).toEqual({ ok: false, error: "bad_frame" });
  });
});

describe("name_kind on agent_up and rename (#393 amendment 1)", () => {
  const up = {
    v: 1,
    id,
    type: "agent_up",
    agent_ref: "s1",
    kind: "pi",
    proposed_name: "pi",
    namespace: "ns",
    global: false,
  };
  const ren = {
    v: 1,
    id,
    type: "rename",
    agent_ref: "s1",
    proposed_name: "OA Backend",
  };

  it("pins the two kinds", () => {
    expect(NAME_KINDS).toEqual(["default", "chosen"]);
  });

  it("is optional on both, and each kind round-trips", () => {
    for (const f of [up, ren]) {
      expect(decodeClientFrame(JSON.stringify(f))).toEqual({
        ok: true,
        frame: f,
      });
      for (const name_kind of NAME_KINDS) {
        const g = { ...f, name_kind };
        expect(decodeClientFrame(encodeFrame(g as never))).toEqual({
          ok: true,
          frame: g,
        });
      }
    }
  });

  it("rejects any other value", () => {
    for (const f of [up, ren])
      for (const name_kind of ["Default", "", "user", 1, null])
        expect(
          decodeClientFrame(JSON.stringify({ ...f, name_kind })).ok,
          String(name_kind),
        ).toBe(false);
  });
});
