import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as bus from "../src/index.ts";
import {
  AgentRefSchema,
  BUS_ROUTES,
  CLIENT_FRAMES,
  CONFIG_FILE,
  INSTANCE_SENDER_NAME,
  isReservedBusName,
  LIMITS,
  MACHINE_TOKEN_PREFIX,
  PROTOCOL_VERSION,
  REFUSAL_REASONS,
  RESERVED_BUS_NAMES,
  SERVER_FRAMES,
} from "../src/index.ts";

const doc = readFileSync(new URL("../CONTRACT.md", import.meta.url), "utf8");

describe("contract is pinned", () => {
  it("is protocol version 1", () => expect(PROTOCOL_VERSION).toBe(1));

  it("keeps OpenBus's values (v1 parity)", () => {
    expect(LIMITS).toMatchObject({
      inlineBodyBytes: 32768,
      maxMessageBytes: 1048576,
      mailTtlSec: 3600,
      inboxCap: 50,
      deviceCodeTtlSec: 600,
      devicePollIntervalSec: 5,
      revokeCloseCode: 4403,
      maxRosterAgents: 1000,
      maxMachinesListed: 100,
    });
    expect(bus.MAX_RAW_FRAME_CHARS).toBe(2 * 1048576 + 4096);
  });

  it("pins the frame lists", () => {
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

  it("pins the 7 refusal reasons, in order", () => {
    expect(REFUSAL_REASONS).toEqual([
      "unknown_agent",
      "closed",
      "inbox_full",
      "too_large",
      "other_namespace",
      "revoked",
      "ambiguous",
    ]);
  });

  it("drops the card, JWKS, link, roles and version gates (design: What moves where)", () => {
    for (const gone of [
      "AGENT_CARD_MIN_CLIENT",
      "KIND_TOKEN_MIN_CLIENT",
      "PRE_TOKEN_KINDS",
      "CARD_TYP",
      "LINK_TYP",
      "CardClaimsSchema",
      "OWNER_ORG_ID",
      "R",
      "AUTH",
      "CSRF_HEADER",
    ])
      expect(gone in bus, gone).toBe(false);
    expect("maxRoles" in LIMITS).toBe(false);
  });

  it("pins the instance routes and the machine token", () => {
    expect(BUS_ROUTES.device).toBe("/bus/device");
    expect(BUS_ROUTES.deviceToken).toBe("/bus/device/token");
    expect(BUS_ROUTES.connect).toBe("/bus/connect");
    expect(MACHINE_TOKEN_PREFIX).toBe("oa_machine_");
  });

  it("pins the reserved bus names and the repo config file", () => {
    expect(INSTANCE_SENDER_NAME).toBe("open-artifacts");
    expect(RESERVED_BUS_NAMES).toEqual([
      "open-artifacts",
      "openbus",
      "open-bus",
    ]);
    expect(isReservedBusName("open--bus")).toBe(true);
    expect(isReservedBusName("Open Artifacts")).toBe(true);
    expect(isReservedBusName("open-artifacts-2")).toBe(true);
    expect(CONFIG_FILE).toBe(".oa-bus.json");
  });
});

describe("CONTRACT.md", () => {
  it("lists every refusal reason as a standalone token", () => {
    for (const t of REFUSAL_REASONS) expect(doc, t).toContain(`\`${t}\``);
  });
  it("mentions every frame, route and the token prefix", () => {
    for (const t of [
      ...CLIENT_FRAMES,
      ...SERVER_FRAMES,
      "4403",
      "recipient_closed",
      "/bus/device",
      "/bus/device/token",
      "/bus/approve",
      "RFC 8628",
      "/bus/connect",
      "oa_machine_",
      ".oa-bus.json",
    ])
      expect(doc, t).toContain(t);
  });
});

describe("agent refs", () => {
  it("reject prototype-pollution names", () => {
    for (const r of ["__proto__", "constructor", "prototype"])
      expect(AgentRefSchema.safeParse(r).success, r).toBe(false);
    expect(AgentRefSchema.safeParse("ses_abc:1").success).toBe(true);
  });
});
