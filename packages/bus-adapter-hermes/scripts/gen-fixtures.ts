// Golden frames shared by the TypeScript and Python sides of the Hermes plugin.
// Each sample is checked against bus-ipc's zod schemas before it is written:
// a valid one must parse and an invalid one must not. Run `pnpm fixtures` after
// a change to a frame; a test fails while the committed files are stale.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AdapterFrame, DaemonFrame } from "@oa/bus-ipc";

type Sample = { name: string; frame: unknown };
type Set = { valid: Sample[]; invalid: Sample[] };

const REF = "0d1c5a52-4f6c-4d0e-9a53-3f7e8d2b9a11";
const MSG = "mmmmmmmmmmmmmmm1";
const b = { v: 1, id: "1" };
const agent = {
  name: "pi-agent",
  namespace: "ns",
  kind: "pi",
  live: true,
  global: false,
};

const adapter: Set = {
  valid: [
    {
      name: "hello",
      frame: {
        ...b,
        id: "hello",
        type: "hello",
        kind: "hermes",
        client_version: "0.0.0",
        agent_ref: REF,
        pid: 4242,
        cwd: "/home/u/proj",
        proposed_name: "hermes-proj",
        caps: ["mailbox", "pending"],
        attest: { proc_start: "Fri Nov  6 21:00:00 2026" },
      },
    },
    {
      name: "hello without optional fields",
      frame: { ...b, type: "hello", kind: "hermes", agent_ref: "s1", pid: 1 },
    },
    { name: "send", frame: { ...b, type: "send", to: "bob", body: "hi" } },
    {
      name: "send to a namespace, asking for late notices",
      frame: {
        ...b,
        type: "send",
        to: "Bob 2",
        body: "héllo ✓",
        namespace: "team/a",
        late: true,
      },
    },
    { name: "list", frame: { ...b, type: "list", late: true } },
    { name: "self", frame: { ...b, type: "self" } },
    { name: "self with row", frame: { ...b, type: "self", row: true } },
    { name: "fetch", frame: { ...b, type: "fetch", msg_id: MSG } },
    { name: "ack", frame: { ...b, id: "ack-3", type: "ack", msg_id: MSG } },
    {
      name: "set_status",
      frame: {
        ...b,
        type: "set_status",
        state: "waiting_on_owner",
        label: "reviewing",
      },
    },
    {
      name: "set_status without label",
      frame: { ...b, type: "set_status", state: "idle" },
    },
  ],
  invalid: [
    {
      name: "unknown kind",
      frame: { ...b, type: "hello", kind: "emacs", agent_ref: "s", pid: 1 },
    },
    {
      name: "pid zero",
      frame: { ...b, type: "hello", kind: "hermes", agent_ref: "s", pid: 0 },
    },
    {
      name: "agent_ref with a space",
      frame: { ...b, type: "hello", kind: "hermes", agent_ref: "a b", pid: 1 },
    },
    {
      name: "agent_ref that is a forbidden name",
      frame: {
        ...b,
        type: "hello",
        kind: "hermes",
        agent_ref: "__proto__",
        pid: 1,
      },
    },
    {
      name: "hello with an empty cwd",
      frame: {
        ...b,
        type: "hello",
        kind: "hermes",
        agent_ref: "s",
        pid: 1,
        cwd: "",
      },
    },
    {
      name: "send with an empty body",
      frame: { ...b, type: "send", to: "bob", body: "" },
    },
    {
      name: "send to an address",
      frame: { ...b, type: "send", to: "1.2.3.4", body: "x" },
    },
    {
      name: "send to a non-canonical namespace",
      frame: { ...b, type: "send", to: "bob", body: "x", namespace: "Team A" },
    },
    {
      name: "fetch with a short msg_id",
      frame: { ...b, type: "fetch", msg_id: "abc" },
    },
    { name: "ack with no msg_id", frame: { ...b, type: "ack" } },
    {
      name: "set_status with a bad state",
      frame: { ...b, type: "set_status", state: "asleep" },
    },
    { name: "self with row false", frame: { ...b, type: "self", row: false } },
    { name: "wrong version", frame: { v: 2, id: "1", type: "list" } },
    { name: "no id", frame: { v: 1, type: "list" } },
    { name: "unknown type", frame: { ...b, type: "shout" } },
  ],
};

const daemon: Set = {
  valid: [
    {
      name: "welcome",
      frame: {
        ...b,
        id: "hello",
        type: "welcome",
        agent_ref: REF,
        bus_name: "hermes-proj",
        namespace: "ns",
        global: false,
      },
    },
    {
      name: "receipt delivered",
      frame: { ...b, type: "receipt", msg_id: MSG, state: "delivered" },
    },
    {
      name: "receipt refused with reason, text and late notices",
      frame: {
        ...b,
        type: "receipt",
        msg_id: "frame-9",
        state: "refused",
        reason: "unknown_agent",
        held: true,
        text: "Held for resend.",
        late: ["Delivered to bob."],
      },
    },
    {
      name: "receipt expired by a closed recipient",
      frame: {
        ...b,
        type: "receipt",
        msg_id: MSG,
        state: "expired",
        reason: "recipient_closed",
      },
    },
    {
      name: "roster",
      frame: {
        ...b,
        type: "roster",
        agents: [
          agent,
          {
            ...agent,
            name: "away-one",
            kind: "claude-code",
            state: "away",
            since: "2026-11-05T10:00:00.000Z",
            machine_label: "laptop",
            status: "working",
            status_label: "building",
            status_at: "2026-11-05T10:01:00.000Z",
          },
          {
            ...agent,
            name: "newer",
            kind: "a-future-kind",
            live: false,
            state: "queued",
          },
        ],
      },
    },
    { name: "empty roster", frame: { ...b, type: "roster", agents: [] } },
    { name: "agent", frame: { ...b, type: "agent", agent } },
    { name: "agent null", frame: { ...b, type: "agent", agent: null } },
    {
      name: "body",
      frame: { ...b, type: "body", msg_id: MSG, body: "the whole body" },
    },
    {
      name: "deliver with a body",
      frame: {
        ...b,
        id: `deliver-${MSG}`,
        type: "deliver",
        msg_id: MSG,
        from_name: "peer",
        namespace: "ns",
        body: "hi",
      },
    },
    {
      name: "deliver with an oversized notice",
      frame: {
        ...b,
        type: "deliver",
        msg_id: MSG,
        from_name: "peer",
        namespace: "ns",
        notice: { size: 2000000, msg_id: MSG },
      },
    },
    {
      name: "notice",
      frame: {
        ...b,
        id: "0",
        type: "notice",
        text: "Your message expired.",
        msg_id: MSG,
      },
    },
    {
      name: "error",
      frame: {
        ...b,
        type: "error",
        code: "bad_frame",
        message: "Unreadable frame",
      },
    },
    { name: "status_set", frame: { ...b, type: "status_set" } },
    {
      name: "status_set with an earlier refusal",
      frame: {
        ...b,
        type: "status_set",
        earlier: { code: "rate_limited", message: "Too often." },
      },
    },
  ],
  invalid: [
    {
      name: "deliver with both body and notice",
      frame: {
        ...b,
        type: "deliver",
        msg_id: MSG,
        from_name: "p",
        namespace: "ns",
        body: "x",
        notice: { size: 1, msg_id: MSG },
      },
    },
    {
      name: "deliver with neither",
      frame: {
        ...b,
        type: "deliver",
        msg_id: MSG,
        from_name: "p",
        namespace: "ns",
      },
    },
    {
      name: "welcome without a bus_name",
      frame: {
        ...b,
        type: "welcome",
        agent_ref: REF,
        namespace: "ns",
        global: false,
      },
    },
    {
      name: "receipt with an unknown state",
      frame: { ...b, type: "receipt", msg_id: MSG, state: "lost" },
    },
    {
      name: "receipt with an unknown reason",
      frame: {
        ...b,
        type: "receipt",
        msg_id: MSG,
        state: "refused",
        reason: "rude",
      },
    },
    {
      name: "roster agent with a bad kind token",
      frame: { ...b, type: "roster", agents: [{ ...agent, kind: "Bad Kind" }] },
    },
    {
      name: "roster agent without live",
      frame: {
        ...b,
        type: "roster",
        agents: [{ name: "a", namespace: "ns", kind: "pi", global: false }],
      },
    },
    {
      name: "notice with empty text",
      frame: { ...b, type: "notice", text: "" },
    },
    {
      name: "error without a code",
      frame: { ...b, type: "error", message: "m" },
    },
    {
      name: "agent that is not an object",
      frame: { ...b, type: "agent", agent: "bob" },
    },
    { name: "version 0", frame: { v: 0, id: "1", type: "status_set" } },
    {
      name: "id too long",
      frame: { v: 1, id: "x".repeat(65), type: "status_set" },
    },
    { name: "unknown type", frame: { ...b, type: "weird" } },
  ],
};

function check(
  set: Set,
  schema: { safeParse(v: unknown): { success: boolean } },
  what: string,
) {
  for (const s of set.valid)
    if (!schema.safeParse(s.frame).success)
      throw new Error(
        `${what} valid sample is rejected by its schema: ${s.name}`,
      );
  for (const s of set.invalid)
    if (schema.safeParse(s.frame).success)
      throw new Error(
        `${what} invalid sample is accepted by its schema: ${s.name}`,
      );
}

/** The fixture files, file name to contents, after the schemas have checked every sample. */
export function buildFixtures(): Record<string, string> {
  check(adapter, AdapterFrame, "adapter");
  check(daemon, DaemonFrame, "daemon");
  const text = (s: Set) => `${JSON.stringify(s, null, 2)}\n`;
  return {
    "adapter-frames.json": text(adapter),
    "daemon-frames.json": text(daemon),
  };
}

export const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  for (const [file, text] of Object.entries(buildFixtures()))
    writeFileSync(join(FIXTURES_DIR, file), text);
}
