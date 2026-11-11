import { describe, expect, it } from "vitest";
import {
  keyId,
  publicFromPkcs8,
  SILENT_TICKET_TTL_MS,
  signBrokerTicket,
  signSilentTicket,
  verifyBrokerTicket,
  verifySilentTicket,
} from "../src/index.js";

const KEY = Buffer.concat([
  Buffer.from("302e020100300506032b657004220420", "hex"),
  Buffer.alloc(32, 5),
]).toString("base64url");
const ctx = { install: "inst-a", aud: "https://a.test" };
const NOW = 1_000_000;
const flow = (o = {}) => ({
  ...ctx,
  sub: "123",
  exp: NOW + 30_000,
  nonce: "abcdefgh1234",
  ...o,
});
const keys = async () => {
  const x = await publicFromPkcs8(KEY);
  return [{ kid: await keyId(x), x }];
};

describe("silent ticket", () => {
  it("verifies for its install and audience and returns the sub", async () => {
    const t = await signSilentTicket(KEY, flow());
    expect(await verifySilentTicket(await keys(), t, ctx, NOW)).toEqual({
      sub: "123",
    });
  });

  it("is bound to install, audience, expiry window and sub (tampering fails)", async () => {
    const t = await signSilentTicket(KEY, flow());
    const k = await keys();
    expect(
      await verifySilentTicket(k, t, { ...ctx, install: "inst-b" }, NOW),
    ).toBeNull();
    expect(
      await verifySilentTicket(k, t, { ...ctx, aud: "https://b.test" }, NOW),
    ).toBeNull();
    expect(await verifySilentTicket(k, t, ctx, NOW + 30_001)).toBeNull();
    const far = await signSilentTicket(
      KEY,
      flow({ exp: NOW + SILENT_TICKET_TTL_MS + 1 }),
    );
    expect(await verifySilentTicket(k, far, ctx, NOW)).toBeNull();
    const parts = t.split(".");
    parts[2] = "456";
    expect(await verifySilentTicket(k, parts.join("."), ctx, NOW)).toBeNull();
  });

  it("never verifies as a broker ticket, and a broker ticket never as silent", async () => {
    const k = await keys();
    const s = await signSilentTicket(KEY, flow());
    expect(
      await verifyBrokerTicket(
        k,
        s,
        { install: "inst-a", state: "s", challenge: "c" },
        NOW,
      ),
    ).toBe(false);
    const b = await signBrokerTicket(KEY, {
      install: "inst-a",
      state: "s",
      challenge: "c",
      exp: NOW + 30_000,
    });
    expect(await verifySilentTicket(k, b, ctx, NOW)).toBeNull();
  });
});
