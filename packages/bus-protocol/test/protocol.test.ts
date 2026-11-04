import { describe, expect, it, vi } from "vitest";
import { LIMITS } from "../src/limits.ts";
import {
  NamespaceSchema,
  namespaceFrom,
  WireNamespaceSchema,
} from "../src/namespace.ts";
import {
  CLIENT_FRAMES,
  decodeClientFrame,
  decodeServerFrame,
  encodeFrame,
  formatFrameError,
  PING,
  PONG,
  SERVER_FRAMES,
} from "../src/protocol.ts";

const id = "7Yb3kQmZ1xRt9PvA";
const mid = "aaaaaaaaaaaaaaaa";
const okc = (raw: string) => {
  const r = decodeClientFrame(raw);
  return r.ok ? r.frame : null;
};
const oks = (raw: string) => {
  const r = decodeServerFrame(raw);
  return r.ok ? r.frame : null;
};

describe("frames", () => {
  it("round-trips a send and a deliver", () => {
    const send = {
      v: 1,
      id,
      type: "send",
      from_ref: "s1",
      to_name: "OpenBus Backend",
      body: "hi",
    } as const;
    expect(okc(encodeFrame(send))).toEqual(send);
    const deliver = {
      v: 1,
      id,
      type: "deliver",
      msg_id: "aaaaaaaaaaaaaaaa",
      to_ref: "s1",
      from_name: "Pi",
      namespace: "github.com/a/b",
      body: "hi",
    } as const;
    expect(oks(encodeFrame(deliver))).toEqual(deliver);
  });
  describe("send.to_namespace", () => {
    const base = {
      v: 1,
      id,
      type: "send",
      from_ref: "s1",
      to_name: "a",
      body: "hi",
    };
    const dec = (extra: object) =>
      decodeClientFrame(JSON.stringify({ ...base, ...extra }));
    it("decodes with none or a canonical one", () => {
      expect(dec({}).ok).toBe(true);
      const r = dec({ to_namespace: "github.com/a/b" });
      expect(r.ok && r.frame).toMatchObject({ to_namespace: "github.com/a/b" });
    });
    it("rejects non-canonical, empty, overlong and extra keys", () => {
      expect(dec({ to_namespace: "GitHub.com/A/B" }).ok).toBe(false);
      expect(dec({ to_namespace: "" }).ok).toBe(false);
      expect(dec({ to_namespace: "a".repeat(129) }).ok).toBe(false);
      expect(dec({ extra: 1 }).ok).toBe(false);
    });
    it("is not a server frame", () => {
      expect(
        decodeServerFrame(JSON.stringify({ ...base, to_namespace: "n" })).ok,
      ).toBe(false);
    });
  });
  it("round-trips an oversized notice", () => {
    const f = {
      v: 1,
      id,
      type: "deliver",
      msg_id: "aaaaaaaaaaaaaaaa",
      to_ref: "s1",
      from_name: "Pi",
      namespace: "n",
      notice: { size: 40000, msg_id: "aaaaaaaaaaaaaaaa" },
    } as const;
    expect(oks(encodeFrame(f))).toEqual(f);
  });
  it("round-trips a refusal", () => {
    const f = {
      v: 1,
      id,
      type: "refuse",
      msg_id: "aaaaaaaaaaaaaaaa",
      reason: "closed",
      detail: "denied",
    } as const;
    expect(okc(encodeFrame(f))).toEqual(f);
    expect(okc(JSON.stringify({ ...f, detail: "held" }))).toBeNull();
    expect(okc(JSON.stringify({ ...f, reason: "inbox_full" }))).toBeNull();
  });
  it("rejects unknown types, wrong versions and extra keys", () => {
    expect(okc(JSON.stringify({ v: 1, id, type: "nope" }))).toBeNull();
    expect(
      okc(
        JSON.stringify({
          v: 2,
          id,
          type: "hello",
          machine_label: "m",
          client_version: "0.1.0",
        }),
      ),
    ).toBeNull();
    expect(
      okc(
        JSON.stringify({
          v: 1,
          id,
          type: "hello",
          machine_label: "m",
          client_version: "0.1.0",
          x: 1,
        }),
      ),
    ).toBeNull();
  });
  it("rejects a body over the hard maximum and a bare ping", () => {
    const big = {
      v: 1,
      id,
      type: "send",
      from_ref: "s1",
      to_name: "a",
      body: "x".repeat(LIMITS.maxMessageBytes + 1),
    };
    expect(decodeClientFrame(JSON.stringify(big))).toEqual({
      ok: false,
      error: "too_large",
      id,
    });
    expect(okc("ping")).toBeNull();
  });
  it("refuses an inbound frame over the read cap without parsing it", () => {
    expect(
      decodeClientFrame("x".repeat(2 * LIMITS.maxMessageBytes + 4097)),
    ).toEqual({ ok: false, error: "too_large" });
  });
  it("names every frame the overview pins", () => {
    expect(CLIENT_FRAMES).toEqual([
      "hello",
      "agent_up",
      "agent_down",
      "sessions",
      "send",
      "ack",
      "refuse",
      "list",
      "fetch",
      "status",
    ]);
    expect(SERVER_FRAMES).toEqual([
      "hello_ok",
      "agent_ok",
      "receipt",
      "roster",
      "body",
      "error",
      "deliver",
      "receipt_update",
      "roster_changed",
    ]);
  });
  it("formats a rejection with the frame id when there is one", () => {
    expect(formatFrameError("bad frame", null)).toBe("bad frame");
    expect(formatFrameError("bad frame", id)).toBe(`bad frame (frame ${id})`);
  });

  it("is direction-safe", () => {
    const deliver = {
      v: 1,
      id,
      type: "deliver",
      msg_id: mid,
      to_ref: "s1",
      from_name: "Pi",
      namespace: "n",
      body: "hi",
    };
    const send = {
      v: 1,
      id,
      type: "send",
      from_ref: "s1",
      to_name: "a",
      body: "hi",
    };
    expect(decodeClientFrame(JSON.stringify(deliver))).toEqual({
      ok: false,
      error: "bad_frame",
      id,
    });
    expect(decodeServerFrame(JSON.stringify(send))).toEqual({
      ok: false,
      error: "bad_frame",
      id,
    });
    expect(
      decodeClientFrame(
        JSON.stringify({
          v: 1,
          id,
          type: "receipt",
          msg_id: mid,
          state: "delivered",
        }),
      ).ok,
    ).toBe(false);
  });
  it("never throws on non-strings", () => {
    for (const x of [null, undefined, 1, {}, new ArrayBuffer(4)]) {
      expect(decodeClientFrame(x as never)).toEqual({
        ok: false,
        error: "bad_frame",
      });
      expect(decodeServerFrame(x as never)).toEqual({
        ok: false,
        error: "bad_frame",
      });
    }
  });
  it("encodes v then id first, so an oversize id can be recovered", () => {
    const s = encodeFrame({ type: "ack", msg_id: mid, id, v: 1 } as never);
    expect(s.startsWith(`{"v":1,"id":"${id}"`)).toBe(true);
    const huge = `{"v":1,"id":"${id}","type":"send","body":"${"x".repeat(2 * LIMITS.maxMessageBytes)}"}`;
    expect(decodeClientFrame(huge)).toEqual({
      ok: false,
      error: "too_large",
      id,
    });
  });
  it("round-trips escape-heavy legal bodies", () => {
    for (const body of [
      '"'.repeat(600_000),
      "\n".repeat(500_000),
      "\0".repeat(170_000),
      '{"a":"b"}'.repeat(100_000),
    ]) {
      const f = {
        v: 1,
        id,
        type: "send",
        from_ref: "s1",
        to_name: "a",
        body,
      } as const;
      expect(okc(encodeFrame(f))).toEqual(f);
    }
  });
  it("pre-scan rejects deep nesting and token floods", () => {
    const deep = `{"v":1,"id":"${id}","type":"ack","msg_id":"${mid}","x":${"[".repeat(5000)}${"]".repeat(5000)}}`;
    expect(decodeClientFrame(deep)).toEqual({ ok: false, error: "bad_frame" });
    const keys = Array.from({ length: 5000 }, (_, i) => `"k${i}":1`).join(",");
    expect(
      decodeClientFrame(`{"v":1,"id":"${id}","type":"ack",${keys}}`).ok,
    ).toBe(false);
    // colons and brackets inside strings are ignored, escapes respected
    const f = {
      v: 1,
      id,
      type: "send",
      from_ref: "s1",
      to_name: "a",
      body: `[[[[[[:,:,"\\${":,".repeat(5000)}`,
    } as const;
    expect(okc(encodeFrame(f))).toEqual(f);
  });
  it("roster rows take an unknown kind token; agent_up does not", () => {
    const a = (kind: string) => ({
      bus_name: "n",
      kind,
      namespace: "a/b",
      global: false,
      state: "live",
    });
    const roster = (...agents: object[]) =>
      JSON.stringify({ v: 1, id, type: "roster", agents });
    expect(oks(roster(a("pi"), a("zeta")))).toMatchObject({
      agents: [{ kind: "pi" }, { kind: "zeta" }],
    });
    for (const bad of ["Zeta", "a b", "", "x".repeat(33)])
      expect(oks(roster(a("pi"), a(bad)))).toBeNull();
    expect(
      okc(
        JSON.stringify({
          v: 1,
          id,
          type: "agent_up",
          agent_ref: "r1",
          kind: "zeta",
          proposed_name: "x",
          namespace: "a/b",
          global: false,
        }),
      ),
    ).toBeNull();
  });
  it("roster agents require state live|queued (#71)", () => {
    const a = { bus_name: "n", kind: "pi", namespace: "a/b", global: false };
    expect(
      oks(JSON.stringify({ v: 1, id, type: "roster", agents: [a] })),
    ).toBeNull();
    for (const s of ["live", "queued"] as const)
      expect(
        oks(
          JSON.stringify({
            v: 1,
            id,
            type: "roster",
            agents: [{ ...a, state: s }],
          }),
        ),
      ).not.toBeNull();
    expect(
      oks(
        JSON.stringify({
          v: 1,
          id,
          type: "roster",
          agents: [{ ...a, state: "gone" }],
        }),
      ),
    ).toBeNull();
    expect(
      oks(
        JSON.stringify({
          v: 1,
          id,
          type: "roster",
          agents: [{ ...a, state: "queued" }],
        }),
      ),
    ).not.toBeNull();
  });
  it("roster rows take an optional machine_label (B13)", () => {
    const a = {
      bus_name: "n",
      kind: "pi",
      namespace: "a/b",
      global: false,
      state: "live",
    };
    const r = (agent: object) =>
      oks(JSON.stringify({ v: 1, id, type: "roster", agents: [agent] }));
    expect(r(a)).not.toBeNull();
    expect(r({ ...a, machine_label: "MacBook" })).toEqual({
      v: 1,
      id,
      type: "roster",
      agents: [{ ...a, machine_label: "MacBook" }],
    });
    // Over the cap, empty, padded or null: rejected; strict decoding stays.
    expect(
      r({ ...a, machine_label: "x".repeat(2 * LIMITS.maxLabelChars + 1) }),
    ).toBeNull();
    expect(
      r({ ...a, machine_label: "x".repeat(2 * LIMITS.maxLabelChars) }),
    ).not.toBeNull();
    for (const bad of ["", " Mac", null, 1])
      expect(r({ ...a, machine_label: bad })).toBeNull();
    expect(r({ ...a, extra: 1 })).toBeNull();
  });
  it("hello_ok label uses MachineLabelSchema", () => {
    const h = {
      v: 1,
      id,
      type: "hello_ok",
      machine_id: "a".repeat(16),
      server_version: "1",
    };
    expect(oks(JSON.stringify({ ...h, machine_label: "Mac‮Book" }))).toBeNull();
    expect(
      oks(JSON.stringify({ ...h, machine_label: "MacBook" })),
    ).not.toBeNull();
  });
  it("decodes a full roster of 1000 max-length agents", () => {
    const agents = Array.from({ length: 1000 }, (_, i) => ({
      bus_name: `${"n".repeat(60)}${String(i).padStart(4, "0")}`,
      kind: "claude-code" as const,
      namespace: `github.com/${"o".repeat(50)}/${"r".repeat(50)}`,
      global: i % 2 === 0,
      state: i % 3 === 0 ? ("queued" as const) : ("live" as const),
    }));
    const f = { v: 1, id, type: "roster", agents } as const;
    expect(oks(encodeFrame(f))).toEqual(f);
    const more = { ...f, agents: [...agents, agents[0]] };
    expect(oks(JSON.stringify(more))).toBeNull();
  });
  // Wall-clock timing flakes on shared CI runners, so it never gates a merge.
  // The gate is structural: the pre-scan rejects floods before JSON.parse
  // (see the JSON.parse spy test). Run locally with OB_PERF=1.
  it.skipIf(!process.env.OB_PERF)(
    "worst adversarial inputs decode fast",
    () => {
      const cap = 2 * LIMITS.maxMessageBytes;
      // Unbounded, these measured 23-28 ms before the pre-scan; the pre-scan
      // must reject them without ever reaching JSON.parse.
      const rejected = [
        `{"v":1,"id":"${id}","x":${"[".repeat(cap / 2)}`,
        `{"v":1,"id":"${id}","type":"hello",${Array.from({ length: 90000 }, (_, i) => `"k${i}":1`).join(",")}}`,
        `{"v":1,"id":"${id}","type":"roster","agents":[${"{},".repeat(350000)}{}]}`,
        `{"v":1,"id":"${id}","type":"roster","agents":[{${Array.from({ length: 5000 }, (_, i) => `"k${i}":1`).join(",")}}]}`,
        `{"v":1,"id":"${id}","type":"hello",${Array.from({ length: 8000 }, (_, i) => `"k${i}":1`).join(",")}}`,
      ];
      const parse = vi.spyOn(JSON, "parse");
      for (const raw of rejected) {
        for (const decode of [decodeClientFrame, decodeServerFrame]) {
          expect(decode(raw)).toEqual({ ok: false, error: "bad_frame" });
        }
      }
      expect(parse).not.toHaveBeenCalled();
      parse.mockRestore();
      const inputs = [
        ...rejected,
        `{"v":1,"id":"${id}","type":"ack"${" ".repeat(cap)}}`,
        `{"v":1,"id":"${id}","type":"roster","agents":[${Array.from({ length: 1000 }, () => `{"bus_name":"${"n".repeat(64)}","kind":"pi","namespace":"${"o".repeat(120)}","global":true,"state":"live"}`).join(",")}]}`,
        `{"v":1,"id":"${id}","type":"send","body":"${'\\"'.repeat(cap / 4)}"}`,
      ];
      // Shared CI runners are slow and noisy (15 ms there). Locally 8 ms stays
      // under the Workers 10 ms CPU budget yet absorbs parallel `pnpm test`
      // load (measured medians are ~3-4 ms). Both still catch a regression to
      // the unbounded 23-28 ms behaviour.
      const sessionRefs = (p: string) =>
        Array.from(
          { length: 1000 },
          (_, i) => `${"a".repeat(120)}${p}${String(i).padStart(4, "0")}`,
        );
      const pre = `{"v":1,"id":"${id}","type":"ack","msg_id":`;
      const cost = [
        JSON.stringify({
          v: 1,
          id,
          type: "sessions",
          open: sessionRefs("o"),
          closed: sessionRefs("c"),
        }),
        `${pre}"${"\\n".repeat(cap / 4 - 40)}`,
        `${pre}"${"\\u0001".repeat(cap / 12 - 40)}"}`,
      ];
      inputs.push(...cost);
      // Relative to a legitimate max-size send decoded in the same loop, so
      // machine speed and parallel load cancel out (allowed: 8x; the worst legal-looking
      // input, 350k \\u0001 escapes, is ~4.2x a plain 1 MB body because
      // JSON.parse decodes every escape); 20 ms is a catastrophic
      // guard everywhere (the unbounded behaviour measured 23-28 ms).
      const baseline = encodeFrame({
        v: 1,
        id,
        type: "send",
        from_ref: "s1",
        to_name: "a",
        body: "a".repeat(LIMITS.maxMessageBytes),
      });
      expect(decodeClientFrame(baseline).ok).toBe(true);
      const median = (xs: number[]) => xs.sort((x, y) => x - y)[7] as number;
      const time = (decode: (r: string) => unknown, raw: string) => {
        const t0 = performance.now();
        decode(raw);
        return performance.now() - t0;
      };
      const MAX_RATIO = 8;
      for (const raw of inputs) {
        for (const decode of [decodeClientFrame, decodeServerFrame]) {
          decode(raw);
          decodeClientFrame(baseline);
          const adv: number[] = [];
          const base: number[] = [];
          for (let i = 0; i < 15; i++) {
            adv.push(time(decode, raw));
            base.push(time(decodeClientFrame, baseline));
          }
          // medians: robust to GC pauses from the multi-MB inputs
          const a = median(adv);
          const b = median(base);
          expect(a).toBeLessThan(20);
          expect(
            a,
            `adversarial ${a}ms vs baseline ${b}ms`,
          ).toBeLessThanOrEqual(MAX_RATIO * b);
        }
      }
    },
  );
  it("accepts only canonical namespaces on the wire", () => {
    const ag = (namespace: string) =>
      JSON.stringify({
        v: 1,
        id,
        type: "agent_up",
        agent_ref: "s1",
        kind: "pi",
        proposed_name: "p",
        namespace,
        global: false,
      });
    expect(okc(ag("github.com/a/b"))).not.toBeNull();
    expect(okc(ag("my-dir_1"))).not.toBeNull();
    for (const bad of [
      "https://GitHub.com/a/b",
      "https://github.com/a/b",
      "git@github.com:a/b.git",
      "GitHub.com/a/b",
      "a b",
      "",
      "a\nb",
      "x".repeat(129),
    ]) {
      expect(okc(ag(bad))).toBeNull();
    }
    // everything the derivation chain and NamespaceSchema produce is wire-valid
    const outs = [
      namespaceFrom({
        remoteUrl: "https://GitHub.com/Acme/Widgets.git",
        gitRootName: null,
        cwd: "/x",
      }),
      namespaceFrom({
        remoteUrl: "git@github.com:Acme/W.git",
        gitRootName: null,
        cwd: "/x",
      }),
      namespaceFrom({
        remoteUrl: `https://github.com/${"a".repeat(200)}/b`,
        gitRootName: null,
        cwd: "/x",
      }),
      namespaceFrom({ remoteUrl: null, gitRootName: "My Repo!", cwd: "/x" }),
      namespaceFrom({ remoteUrl: null, gitRootName: "Café Ünï", cwd: "/x" }),
      namespaceFrom({ remoteUrl: null, gitRootName: null, cwd: "/a/B c" }),
      namespaceFrom({ remoteUrl: null, gitRootName: null, cwd: "/" }),
      NamespaceSchema.parse("https://GitHub.com/a/b"),
      NamespaceSchema.parse("GitHub.com/a/b"),
    ];
    for (const o of outs) {
      expect(WireNamespaceSchema.safeParse(o).success, o).toBe(true);
    }
  });
  it("bounds strings, refs, sessions and deliver", () => {
    const base = { v: 1, id } as const;
    const hello = {
      ...base,
      type: "hello",
      machine_label: "m",
      client_version: "0.1.0",
    };
    expect(
      okc(JSON.stringify({ ...hello, machine_label: "a".repeat(129) })),
    ).toBeNull();
    expect(
      okc(JSON.stringify({ ...hello, machine_label: "a\u202eb" })),
    ).toBeNull();
    expect(okc(JSON.stringify({ ...hello, machine_label: "a\nb" }))).toBeNull();
    expect(
      okc(JSON.stringify({ ...hello, client_version: "1".repeat(65) })),
    ).toBeNull();
    expect(
      oks(
        JSON.stringify({
          ...base,
          type: "error",
          code: "internal",
          message: "x".repeat(1025),
        }),
      ),
    ).toBeNull();
    expect(
      oks(
        JSON.stringify({
          ...base,
          type: "hello_ok",
          machine_id: "a".repeat(16),
          machine_label: "x".repeat(129),
          server_version: "1",
        }),
      ),
    ).toBeNull();
    for (const ref of ["__proto__", "constructor", "prototype", "a b", "é"]) {
      expect(
        okc(JSON.stringify({ ...base, type: "agent_down", agent_ref: ref })),
      ).toBeNull();
    }
    expect(
      okc(
        JSON.stringify({
          ...base,
          type: "agent_down",
          agent_ref: "ses_a.b:c-d",
        }),
      ),
    ).not.toBeNull();
    const s = (open: string[], closed: string[]) =>
      okc(JSON.stringify({ ...base, type: "sessions", open, closed }));
    expect(s(["a", "b"], ["c"])).not.toBeNull();
    expect(s(["a", "a"], [])).toBeNull();
    expect(s([], ["a", "a"])).toBeNull();
    expect(s(["a"], ["a"])).toBeNull();
    const dv = {
      ...base,
      type: "deliver",
      msg_id: mid,
      to_ref: "s1",
      from_name: "Pi",
      namespace: "n",
    };
    expect(
      oks(JSON.stringify({ ...dv, body: "x".repeat(LIMITS.inlineBodyBytes) })),
    ).not.toBeNull();
    expect(
      oks(
        JSON.stringify({ ...dv, body: "x".repeat(LIMITS.inlineBodyBytes + 1) }),
      ),
    ).toBeNull();
    const n = (size: number, m = mid) =>
      oks(JSON.stringify({ ...dv, notice: { size, msg_id: m } }));
    expect(n(LIMITS.inlineBodyBytes + 1)).not.toBeNull();
    expect(n(LIMITS.maxMessageBytes)).not.toBeNull();
    expect(n(LIMITS.inlineBodyBytes)).toBeNull();
    expect(n(LIMITS.maxMessageBytes + 1)).toBeNull();
    expect(n(40000, "bbbbbbbbbbbbbbbb")).toBeNull();
  });
  it("applies receipt rules on the wire", () => {
    const r = (type: string, state: string, reason?: string) =>
      JSON.stringify({
        v: 1,
        id,
        type,
        msg_id: mid,
        state,
        ...(reason ? { reason } : {}),
      });
    expect(oks(r("receipt", "pending"))).not.toBeNull();
    expect(oks(r("receipt", "refused", "inbox_full"))).not.toBeNull();
    expect(oks(r("receipt", "delivered"))).toBeNull();
    expect(oks(r("receipt", "refused"))).toBeNull();
    expect(oks(r("receipt", "pending", "closed"))).toBeNull();
    expect(oks(r("receipt_update", "delivered"))).not.toBeNull();
    expect(
      oks(r("receipt_update", "expired", "recipient_closed")),
    ).not.toBeNull();
    expect(oks(r("receipt_update", "delivered", "inbox_full"))).toBeNull();
    expect(oks(r("receipt_update", "refused", "recipient_closed"))).toBeNull();
    expect(oks(r("receipt_update", "expired", "too_large"))).toBeNull();
  });
});

describe("keepalive", () => {
  it("PING and PONG are bare strings from protocol, never frames", () => {
    expect(PING).toBe("ping");
    expect(PONG).toBe("pong");
    expect(decodeClientFrame(PING).ok).toBe(false);
    expect(decodeServerFrame(PONG).ok).toBe(false);
  });
});

describe("AGENT_CAP_MESSAGES (B11)", () => {
  it("pins the exact agent_up cap refusal messages clients match on", async () => {
    const { AGENT_CAP_MESSAGES } = await import("../src/protocol.ts");
    expect(AGENT_CAP_MESSAGES).toEqual({
      machine: "Too many live agents on this machine",
      member: "Too many live agents on this bus",
    });
  });
});

describe("status frames, and no card frames", () => {
  const roundTrip = (f: object, client: boolean) => {
    const raw = JSON.stringify(f);
    const got = client ? okc(raw) : oks(raw);
    expect(got, raw).toEqual(f);
    expect(encodeFrame(got as never)).toBe(raw);
  };
  it("round-trips status", () => {
    roundTrip(
      { v: 1, id, type: "status", from_ref: "s1", state: "working" },
      true,
    );
    roundTrip(
      {
        v: 1,
        id,
        type: "status",
        from_ref: "s1",
        state: "waiting_on_owner",
        label: "needs a review",
      },
      true,
    );
  });
  it("refuses bad status fields and every card frame (design: card dropped)", () => {
    const bad = [
      { v: 1, id, type: "status", from_ref: "s1", state: "asleep" },
      { v: 1, id, type: "status", from_ref: "s1", state: "idle", label: "" },
      {
        v: 1,
        id,
        type: "card_request",
        from_ref: "s1",
        aud: "https://oa.example.com/",
        nonce: "n".repeat(16),
      },
      {
        v: 1,
        id,
        type: "card_request",
        from_ref: "s1",
        aud: "https://oa.example.com",
        nonce: "short",
      },
      // A well-formed OpenBus card request, and the bare frame type.
      {
        v: 1,
        id,
        type: "card_request",
        from_ref: "s1",
        aud: "https://oa.example.com",
        nonce: "n".repeat(16),
      },
      { v: 1, id, type: "card_request", from_ref: "s1" },
    ];
    for (const f of bad) expect(okc(JSON.stringify(f))).toBeNull();
    expect(
      oks(JSON.stringify({ v: 1, id, type: "card", jwt: "aGk.eyJ9.c2ln" })),
    ).toBeNull();
    expect(
      oks(
        JSON.stringify({ v: 1, id, type: "card_refused", code: "not_linked" }),
      ),
    ).toBeNull();
    // Direction-safe: the hub never accepts a server frame and vice versa.
    expect(
      okc(JSON.stringify({ v: 1, id, type: "card", jwt: "a.b.c" })),
    ).toBeNull();
    expect(
      oks(
        JSON.stringify({
          v: 1,
          id,
          type: "status",
          from_ref: "s1",
          state: "idle",
        }),
      ),
    ).toBeNull();
  });
  it("a roster row carries status but no role", () => {
    const row = {
      bus_name: "code-96",
      kind: "claude-code",
      namespace: "a/b",
      global: false,
      state: "live",
      status: "blocked",
      status_label: "waiting on CI",
      status_at: "2026-10-29T12:00:00.000Z",
    };
    roundTrip({ v: 1, id, type: "roster", agents: [row] }, false);
    expect(
      oks(
        JSON.stringify({
          v: 1,
          id,
          type: "roster",
          agents: [{ ...row, status_at: "yesterday" }],
        }),
      ),
    ).toBeNull();
    expect(
      oks(
        JSON.stringify({
          v: 1,
          id,
          type: "roster",
          agents: [{ ...row, role: "lane-6" }],
        }),
      ),
    ).toBeNull();
  });
  it("a receipt carries no role fields", () => {
    roundTrip(
      { v: 1, id, type: "receipt", msg_id: mid, state: "pending" },
      false,
    );
    expect(
      oks(
        JSON.stringify({
          v: 1,
          id,
          type: "receipt",
          msg_id: mid,
          state: "pending",
          to_name: "code-96",
        }),
      ),
    ).toBeNull();
    expect(
      oks(
        JSON.stringify({
          v: 1,
          id,
          type: "receipt",
          msg_id: mid,
          state: "refused",
          reason: "role_vacant",
        }),
      ),
    ).toBeNull();
  });
});
