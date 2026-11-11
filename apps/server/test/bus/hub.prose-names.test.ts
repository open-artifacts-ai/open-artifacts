// #1916: a harness-made title (agent_up) that reads as prose, or that starts
// with another live agent's full name plus more than one word, becomes the
// fallback name. A user's rename (`rename`, name_kind chosen) never does.
// Prefix scope is nameTaken's: the namespace plus globals.
import type { ClientFrame, ServerFrame } from "@oa/bus-protocol";
import { describe, expect, it } from "vitest";
import {
  type Daemon,
  daemon,
  hello,
  machine,
  ns,
  up,
  waitFor,
} from "./helpers.js";

let seq = 0;
const id = (t: string) => `${t}${++seq}`;
const uniq = (t: string) => `${t}${++seq}x${Date.now() % 1e8}`;
const FALLBACK = /^agent(-\d+)?$/;

async function connect(): Promise<Daemon> {
  const m = await machine();
  const d = await daemon(m.token);
  d.send(hello(id("h")));
  await waitFor(d, "hello_ok");
  return d;
}

async function reg(
  d: Daemon,
  name: string,
  namespace: string,
  global = false,
): Promise<string> {
  d.send(up(id("u"), uniq("ref"), name, namespace, global));
  return (await waitFor(d, "agent_ok")).bus_name;
}

async function regKind(
  d: Daemon,
  kind: string,
  name: string,
  namespace: string,
): Promise<string> {
  d.send({
    ...up(id("u"), uniq("ref"), name, namespace),
    kind,
  } as ClientFrame);
  return (await waitFor(d, "agent_ok")).bus_name;
}

async function regRef(
  d: Daemon,
  ref: string,
  name: string,
  namespace: string,
): Promise<string> {
  d.send(up(id("u"), ref, name, namespace));
  return (await waitFor(d, "agent_ok")).bus_name;
}

async function rename(
  d: Daemon,
  ref: string,
  name: string,
): Promise<Extract<ServerFrame, { type: "renamed" }>> {
  const fid = id("r");
  d.send({
    v: 1,
    id: fid,
    type: "rename",
    agent_ref: ref,
    proposed_name: name,
    name_kind: "chosen",
  } as ClientFrame);
  return waitFor(d, "renamed");
}

const PROSE = "OA Manager One thing I noticed: If I @-mention an agent in a c";

describe("prose and impersonating harness names (#1916)", () => {
  it("agent_up: prose becomes the fallback; real names stay", async () => {
    const d = await connect();
    const n = ns("prose");
    expect(await reg(d, PROSE, n)).toMatch(FALLBACK);
    const keep = uniq("OA Hermes");
    expect(await reg(d, keep, n)).toBe(keep);
  });

  it("agent_up: another live agent's name plus a sentence is the fallback", async () => {
    const d = await connect();
    const n = ns("imp");
    const base = uniq("Plat");
    expect(await reg(d, base, n)).toBe(base);
    expect(await reg(d, `${base} B`, n)).toBe(`${base} B`);
    expect(await reg(d, `${base} fork`, n)).toBe(`${base} fork`);
    expect(await reg(d, `${base} two words`, n)).toMatch(FALLBACK);
  });

  it("the prefix rule ignores another namespace's agent, counts a global", async () => {
    const d = await connect();
    const base = uniq("Scoped");
    await reg(d, base, ns("other"));
    expect(await reg(d, `${base} two words`, ns("here"))).toBe(
      `${base} two words`,
    );
    const g = uniq("Glob");
    await reg(d, g, ns("home"), true);
    expect(await reg(d, `${g} two words`, ns("elsewhere"))).toMatch(FALLBACK);
  });

  it("rename (a user's choice) applies neither rule", async () => {
    const d = await connect();
    const n = ns("ren");
    const base = uniq("Boss");
    await reg(d, base, n);
    const ref = uniq("ref");
    await regRef(d, ref, uniq("tmp"), n);
    const long = `${base} one two three four five`;
    const r = await rename(d, ref, long);
    expect(r.bus_name).toBe(long);
  });

  it("an agent keeping its own current name on a repeat agent_up is untouched", async () => {
    const d = await connect();
    const n = ns("keep");
    const base = uniq("Lead");
    await reg(d, base, n);
    const ref = uniq("ref");
    await regRef(d, ref, uniq("tmp"), n);
    const long = `${base} one two three four five`;
    await rename(d, ref, long);
    expect(await regRef(d, ref, long, n)).toBe(long);
  });

  it("claude-code agent_up is a user choice: both rules are off", async () => {
    const d = await connect();
    const n = ns("cc");
    const long = uniq("Why does this one keep failing");
    expect(await regKind(d, "claude-code", long, n)).toBe(long);
    const base = uniq("Prime");
    await reg(d, base, n);
    const imp = `${base} two words`;
    expect(await regKind(d, "claude-code", imp, n)).toBe(imp);
  });

  it("a codex agent_up with the same long title still falls back", async () => {
    const d = await connect();
    const n = ns("cx");
    expect(
      await regKind(d, "codex", uniq("Why does this one keep failing"), n),
    ).toMatch(FALLBACK);
  });
});
