// #2561: a hand-run `oa-bus install` marks "setup pending" for its machine
// (POST R.busSetup, machine token); one `setup_claim` takes the mark and
// clears it in the same statement, so two racing sessions get one `true`.
// A socket that did not list the cap hears nothing it could not decode.
import { env } from "cloudflare:workers";
import { BUS_CAPS, type ClientFrame } from "@oa/bus-protocol";
import { R } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { fetchAndWait } from "../helpers.js";
import { daemon, hello, machine, waitFor } from "./helpers.js";

const app = createApp();
const APP = "http://app.localhost";

const mark = (token: string | null) =>
  fetchAndWait(
    app,
    new Request(`${APP}${R.busSetup}`, {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
    env,
  );
const flag = async (id: string) =>
  (
    await env.DB.prepare(
      "select setup_pending p from bus_machines where id = ?",
    )
      .bind(id)
      .first<{ p: number }>()
  )?.p;
async function open(token: string, caps: string[]) {
  const d = await daemon(token);
  d.send({ ...hello("h0"), caps } as ClientFrame);
  const ok = await waitFor(d, "hello_ok");
  return { d, ok };
}
const claim = (d: Awaited<ReturnType<typeof daemon>>, id: string) =>
  d.send({ v: 1, id, type: "setup_claim" } as ClientFrame);

describe("setup pending (#2561)", () => {
  it("install marks the machine; a bad token marks nothing", async () => {
    const m = await machine("Mk");
    expect(await flag(m.id)).toBe(0);
    expect((await mark(null)).status).toBe(401);
    expect((await mark("oa_machine_nope")).status).toBe(401);
    expect(await flag(m.id)).toBe(0);
    expect((await mark(m.token)).status).toBe(204);
    expect(await flag(m.id)).toBe(1);
  });

  it("two sessions racing: exactly one gets it, and it is cleared", async () => {
    const m = await machine("Race");
    await mark(m.token);
    const { d, ok } = await open(m.token, [BUS_CAPS.setup]);
    expect(ok.caps).toContain(BUS_CAPS.setup);
    claim(d, "c1");
    claim(d, "c2");
    const a = await waitFor(d, "setup_claimed");
    const b = await waitFor(d, "setup_claimed");
    expect([a.pending, b.pending].sort()).toEqual([false, true]);
    expect(await flag(m.id)).toBe(0);
    claim(d, "c3");
    expect((await waitFor(d, "setup_claimed")).pending).toBe(false);
  });

  it("another machine's mark is not taken", async () => {
    const a = await machine("A");
    const b = await machine("B");
    await mark(a.token);
    const { d } = await open(b.token, [BUS_CAPS.setup]);
    claim(d, "c1");
    expect((await waitFor(d, "setup_claimed")).pending).toBe(false);
    expect(await flag(a.id)).toBe(1);
  });

  it("an older daemon (no cap) gets bad_frame and keeps the mark", async () => {
    const m = await machine("Old");
    await mark(m.token);
    const { d, ok } = await open(m.token, []);
    expect(ok.caps ?? []).not.toContain(BUS_CAPS.setup);
    claim(d, "c1");
    expect(await waitFor(d, "error")).toMatchObject({
      id: "c1",
      code: "bad_frame",
    });
    expect(await flag(m.id)).toBe(1);
  });
});
