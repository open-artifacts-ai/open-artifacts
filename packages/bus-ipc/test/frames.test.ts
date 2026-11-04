import { describe, expect, it } from "vitest";
import {
  AdapterFrame,
  AGENT_REF,
  DaemonFrame,
  Hello,
  MAX_LINE_BYTES,
} from "../src/frames.ts";

describe("local frame contract v1", () => {
  it("accepts a hello with no sender-supplied name field", () => {
    const frame = AdapterFrame.parse({
      v: 1,
      id: "1",
      type: "hello",
      kind: "claude-code",
      agent_ref: "8a1f",
      pid: 4321,
      cwd: "/repo",
      attest: { session_id: "8a1f", socket_path: "/tmp/cc-socks/4321.sock" },
    });
    expect(frame.type).toBe("hello");
    expect("from" in frame).toBe(false);
  });

  it("strips a sender-supplied from on send", () => {
    const bad = {
      v: 1,
      id: "2",
      type: "send",
      from: "someone-else",
      to: "peer",
      body: "hi",
    };
    expect(AdapterFrame.parse(bad)).not.toHaveProperty("from");
  });

  it("rejects an oversized body at the schema", () => {
    expect(() =>
      AdapterFrame.parse({
        v: 1,
        id: "3",
        type: "send",
        to: "peer",
        body: "x".repeat(1024 * 1024 + 1),
      }),
    ).toThrow();
  });

  it("caps the body in UTF-8 bytes, not characters", () => {
    // 400k chars x 3 bytes = 1.2 MB: under the char count, over the byte cap
    const body = "€".repeat(400_000);
    expect(body.length).toBeLessThan(1024 * 1024);
    expect(() =>
      AdapterFrame.parse({ v: 1, id: "4", type: "send", to: "peer", body }),
    ).toThrow();
    expect(
      AdapterFrame.parse({
        v: 1,
        id: "5",
        type: "send",
        to: "peer",
        body: "€".repeat(300_000),
      }).type,
    ).toBe("send");
  });

  it("rejects an empty body", () => {
    expect(() =>
      AdapterFrame.parse({ v: 1, id: "6", type: "send", to: "peer", body: "" }),
    ).toThrow();
  });

  it("caps a line above the body cap", () => {
    expect(MAX_LINE_BYTES).toBe(4 * 1024 * 1024);
  });

  it("accepts a deliver with a notice instead of a body", () => {
    const f = DaemonFrame.parse({
      v: 1,
      id: "9",
      type: "deliver",
      msg_id: "m1",
      from_name: "peer",
      namespace: "github.com/acme/app",
      notice: { size: 40000, msg_id: "m1" },
    });
    expect(f.type).toBe("deliver");
  });

  it("a deliver must carry exactly one of body or notice", () => {
    const base = {
      v: 1,
      id: "0",
      type: "deliver",
      msg_id: "m",
      from_name: "p",
      namespace: "n",
    };
    expect(() => DaemonFrame.parse(base)).toThrow();
    expect(() =>
      DaemonFrame.parse({
        ...base,
        body: "x",
        notice: { size: 1, msg_id: "m" },
      }),
    ).toThrow();
    expect(DaemonFrame.parse({ ...base, body: "x" }).type).toBe("deliver");
  });
});

describe("AGENT_REF", () => {
  it("caps at 128 characters like the shared contract", () => {
    expect(AGENT_REF.safeParse("a".repeat(128)).success).toBe(true);
    expect(AGENT_REF.safeParse("a".repeat(129)).success).toBe(false);
  });
});

describe("F2.4 shared contract", () => {
  it("REFUSAL is the shared list, ambiguous included", async () => {
    const { REFUSAL } = await import("../src/frames.ts");
    const { REFUSAL_REASONS } = await import("@oa/bus-protocol");
    expect(REFUSAL.options).toEqual([...REFUSAL_REASONS]);
    expect(REFUSAL.parse("ambiguous")).toBe("ambiguous");
  });

  it("a roster agent carries its state", () => {
    const f = DaemonFrame.parse({
      v: 1,
      id: "1",
      type: "roster",
      agents: [
        {
          name: "a",
          namespace: "ns",
          kind: "pi",
          live: false,
          state: "queued",
          global: false,
        },
      ],
    });
    expect(f).toMatchObject({ agents: [{ state: "queued", live: false }] });
  });

  it("daemon frames take an unknown kind token; hello does not", () => {
    const row = (kind: string) => ({
      name: "a",
      namespace: "ns",
      kind,
      live: true,
      state: "live",
      global: false,
    });
    expect(
      DaemonFrame.parse({
        v: 1,
        id: "1",
        type: "roster",
        agents: [row("pi"), row("zeta")],
      }),
    ).toMatchObject({ agents: [{ kind: "pi" }, { kind: "zeta" }] });
    expect(
      DaemonFrame.parse({ v: 1, id: "1", type: "agent", agent: row("zeta") }),
    ).toMatchObject({ agent: { kind: "zeta" } });
    expect(() =>
      DaemonFrame.parse({
        v: 1,
        id: "1",
        type: "roster",
        agents: [row("Not A Kind")],
      }),
    ).toThrow();
    expect(
      AdapterFrame.safeParse({
        v: 1,
        id: "1",
        type: "hello",
        kind: "zeta",
        agent_ref: "8a1f",
        pid: 1,
        cwd: "/repo",
      }).success,
    ).toBe(false);
  });

  it("send takes an optional target namespace", () => {
    const send = { v: 1, id: "1", type: "send", to: "peer", body: "hi" };
    expect(
      AdapterFrame.parse({ ...send, namespace: "github.com/acme/app" }),
    ).toMatchObject({ namespace: "github.com/acme/app" });
    expect(AdapterFrame.parse(send)).not.toHaveProperty("namespace");
    expect(() => AdapterFrame.parse({ ...send, namespace: "a\nb" })).toThrow();
  });
});

describe("adapter text must be well-formed unicode", () => {
  const send = (body: string) => ({
    v: 1,
    id: "1",
    type: "send",
    to: "peer",
    body,
  });
  it("a send body with a lone surrogate is rejected", () => {
    for (const body of ["a\ud800", "\udc00b", "x\udc00\ud800y"])
      expect(AdapterFrame.safeParse(send(body)).success, body).toBe(false);
    expect(AdapterFrame.safeParse(send("ok 😀")).success).toBe(true);
  });
  it("a hello's proposed_name with a lone surrogate is rejected", () => {
    const hello = (proposed_name: string) => ({
      v: 1,
      id: "h",
      type: "hello",
      kind: "pi",
      agent_ref: "s1",
      pid: 1,
      cwd: "/",
      proposed_name,
    });
    expect(AdapterFrame.safeParse(hello("p\ud800")).success).toBe(false);
    expect(AdapterFrame.safeParse(hello("p😀")).success).toBe(true);
  });
});

describe("codex hello facts (C26b)", () => {
  const base = {
    v: 1,
    id: "hello",
    type: "hello",
    kind: "codex",
    agent_ref: "019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b",
    pid: 4321,
    cwd: "/repo",
    attest: {},
  };
  const codex = {
    thread_id: "019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b",
    call_id: "call_abc123",
    ppid: 4000,
    thread_source: "user",
  };

  it("carries the thread, the call and the parent", () => {
    expect(Hello.parse({ ...base, codex }).codex).toEqual(codex);
  });

  it("is optional: a hello without it, as every other kind sends, still parses", () => {
    const h = Hello.parse({ ...base, kind: "claude-code" });
    expect(h).not.toHaveProperty("codex");
  });

  it("an older daemon, whose Hello lacks the field, strips it rather than refusing", () => {
    const older = Hello.omit({ codex: true });
    const h = older.parse({ ...base, codex });
    expect(h).not.toHaveProperty("codex");
  });

  it("may leave out thread_source, which the daemon reads from Codex's state (C26j)", () => {
    const { thread_source: _, ...bare } = codex;
    expect(Hello.parse({ ...base, codex: bare }).codex).toEqual(bare);
  });

  it("may leave out cwd, which the daemon reads from the rollout (C26j)", () => {
    const { cwd: _, ...noCwd } = base;
    expect(Hello.parse({ ...noCwd, codex })).not.toHaveProperty("cwd");
    expect(AdapterFrame.safeParse({ ...noCwd, codex }).success).toBe(true);
  });

  it("carries a code-mode call's item and turn ids, which an older daemon strips (C27)", () => {
    const code = {
      ...codex,
      call_id: "exec-0b5c2a8e-3f1d-4c6a-9e2b-7d4f1a3c5e6b",
      item_id: "ctc_synthetic01",
      turn_id: "019a2b3c-0000-7f60-8a9b-0c1d2e3f4a5b",
    };
    expect(Hello.parse({ ...base, codex: code }).codex).toEqual(code);
    const older = Hello.extend({
      codex: Hello.shape.codex
        .unwrap()
        .omit({ item_id: true, turn_id: true })
        .optional(),
    });
    expect(older.parse({ ...base, codex: code }).codex).toEqual({
      ...codex,
      call_id: code.call_id,
    });
  });

  it("refuses a partial or odd codex block", () => {
    for (const bad of [
      { ...codex, call_id: "" },
      { ...codex, ppid: 0 },
      { thread_id: codex.thread_id, ppid: 1 },
      { ...codex, thread_id: "../etc" },
      { ...codex, thread_source: "" },
      { ...codex, thread_source: "x".repeat(65) },
      { ...codex, item_id: "" },
      { ...codex, turn_id: "x".repeat(257) },
    ])
      expect(Hello.safeParse({ ...base, codex: bad }).success).toBe(false);
  });
});
