import { describe, expect, test } from "vitest";
import {
  BROKER_TICKET_TTL_MS,
  isPlatformPrincipalId,
  PLATFORM_PRINCIPAL_IDS,
  signBrokerTicket,
  ticketTranscript,
  verifyBrokerTicket,
} from "../src/broker-ticket.js";
import {
  keyId,
  publicFromPkcs8,
  verifyRequest,
  verifyTranscript,
} from "../src/ed25519.js";

// The platform-principal ticket (design v7 4.3, "Broker change"): an Ed25519
// signature by ADMIN_BROKER_KEY over install, state, challenge and exp.

const pk = (fill: number) =>
  Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.alloc(32, fill),
  ]).toString("base64url");
const KEY = pk(7);
const OTHER = pk(8);
const NOW = 1_800_000_000_000;
const FLOW = {
  install: "i000000admin",
  state: "s".repeat(43),
  challenge: "c".repeat(43),
};

async function keys(...pkcs8: string[]) {
  const out = [];
  for (const k of pkcs8) {
    const x = await publicFromPkcs8(k);
    out.push({ kid: await keyId(x), x });
  }
  return out;
}

describe("broker ticket", () => {
  test("transcript is the design's exact bytes", () => {
    expect(ticketTranscript({ ...FLOW, exp: 5 })).toBe(
      `oa-broker-ticket-v1\ni000000admin\n${FLOW.state}\n${FLOW.challenge}\n5`,
    );
  });

  test("the signature covers exactly the transcript, not a request transcript", async () => {
    const [k] = await keys(KEY);
    const f = { ...FLOW, exp: NOW + 1000 };
    const [, kid, sig] = (await signBrokerTicket(KEY, f)).split(".") as [
      string,
      string,
      string,
    ];
    expect(kid).toBe(k?.kid);
    expect(await verifyTranscript(k?.x ?? "", ticketTranscript(f), sig)).toBe(
      true,
    );
    expect(
      await verifyRequest(
        k?.x ?? "",
        "/google/authorize",
        kid,
        ticketTranscript(f),
        sig,
      ),
    ).toBe(false);
  });

  test("a fresh ticket verifies against the entry's keys", async () => {
    const t = await signBrokerTicket(KEY, { ...FLOW, exp: NOW + 60_000 });
    expect(await verifyBrokerTicket(await keys(OTHER, KEY), t, FLOW, NOW)).toBe(
      true,
    );
  });

  test.each([
    ["state", { state: "x".repeat(43) }],
    ["challenge", { challenge: "d".repeat(43) }],
    ["install", { install: "i00000signup" }],
  ])("bound to the %s", async (_w, change) => {
    const t = await signBrokerTicket(KEY, { ...FLOW, exp: NOW + 60_000 });
    expect(
      await verifyBrokerTicket(await keys(KEY), t, { ...FLOW, ...change }, NOW),
    ).toBe(false);
  });

  test("expired, or exp beyond now + 10 min, is refused", async () => {
    const k = await keys(KEY);
    const at = async (exp: number) =>
      verifyBrokerTicket(
        k,
        await signBrokerTicket(KEY, { ...FLOW, exp }),
        FLOW,
        NOW,
      );
    expect(await at(NOW - 1)).toBe(false);
    expect(await at(NOW + BROKER_TICKET_TTL_MS)).toBe(true);
    expect(await at(NOW + BROKER_TICKET_TTL_MS + 1)).toBe(false);
  });

  test("another key, a tampered exp, or junk is refused", async () => {
    const t = await signBrokerTicket(OTHER, { ...FLOW, exp: NOW + 1000 });
    expect(await verifyBrokerTicket(await keys(KEY), t, FLOW, NOW)).toBe(false);
    const good = await signBrokerTicket(KEY, { ...FLOW, exp: NOW + 1000 });
    const [, kid, sig] = good.split(".");
    expect(
      await verifyBrokerTicket(
        await keys(KEY),
        `${NOW + 2000}.${kid}.${sig}`,
        FLOW,
        NOW,
      ),
    ).toBe(false);
    for (const junk of ["", "x", "1.2", "a.b.c", `${NOW + 1}..`, `${good}.x`])
      expect(await verifyBrokerTicket(await keys(KEY), junk, FLOW, NOW)).toBe(
        false,
      );
  });

  test("a kid that does not derive from its x is refused", async () => {
    const t = await signBrokerTicket(KEY, { ...FLOW, exp: NOW + 1000 });
    const [real] = await keys(KEY);
    const [other] = await keys(OTHER);
    expect(
      await verifyBrokerTicket(
        [{ kid: (real as { kid: string }).kid, x: (other as { x: string }).x }],
        t,
        FLOW,
        NOW,
      ),
    ).toBe(false);
  });

  test("platform principals", () => {
    expect(PLATFORM_PRINCIPAL_IDS).toEqual(["i000000admin", "i00000signup"]);
    expect(isPlatformPrincipalId("i000000admin")).toBe(true);
    expect(isPlatformPrincipalId("iabcdefghijk")).toBe(false);
  });
});
