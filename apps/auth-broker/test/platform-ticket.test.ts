import { env } from "cloudflare:workers";
import {
  BROKER_TICKET_TTL_MS,
  keyId,
  PLATFORM_PRINCIPAL_IDS,
  publicFromPkcs8,
  signBrokerTicket,
} from "@oa/auth-core";
import { PLATFORM_PRINCIPAL_IDS as PROVISION_IDS } from "@oa/provision/names";
import { beforeEach, describe, expect, it } from "vitest";
import broker, { type Env } from "../src/index.js";
import { clearRegistryCache } from "../src/registry.js";

// The platform-principal ticket (design v7 4.3, "Broker change"): for
// i000000admin and i00000signup, authorize requires an Ed25519 ticket over
// install, state, challenge and exp, verified before the install bucket is
// charged. Unsigned or bad: 404, no charge. Installs are unchanged.

const BROKER = "https://auth.hosted.test";
const CH = "A".repeat(43);
const pk = (fill: number) =>
  Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.alloc(32, fill),
  ]).toString("base64url");
const ADMIN_KEY = pk(11);
const OTHER_KEY = pk(12);

const limiter = () => {
  const keys: string[] = [];
  return {
    keys,
    limit: async ({ key }: { key: string }) => (keys.push(key), { success: true }),
  };
};
let ipLimit: ReturnType<typeof limiter>;
let installLimit: ReturnType<typeof limiter>;
const E = () =>
  ({ ...env, RL_BROKER_IP: ipLimit, RL_BROKER_INSTALL: installLimit }) as Env;

beforeEach(async () => {
  clearRegistryCache();
  ipLimit = limiter();
  installLimit = limiter();
  const x = await publicFromPkcs8(ADMIN_KEY);
  await env.BROKER_REGISTRY.put(
    "install:i000000admin",
    JSON.stringify({
      installId: "i000000admin",
      origin: "https://admin.hosted.test",
      keys: [{ kid: await keyId(x), x }],
      domains: [],
    }),
  );
  const y = await publicFromPkcs8(OTHER_KEY);
  await env.BROKER_REGISTRY.put(
    "install:iabcdefghijk",
    JSON.stringify({
      installId: "iabcdefghijk",
      origin: "https://a.hosted.test",
      keys: [{ kid: await keyId(y), x: y }],
      domains: ["a.com"],
    }),
  );
});

const authorize = (q: Record<string, string>) =>
  broker.fetch(
    new Request(
      `${BROKER}/google/authorize?${new URLSearchParams({ state: "st", nonce: "n", code_challenge: CH, ...q })}`,
      { headers: { "x-oa-gate-install": "i000000admin" } },
    ) as never,
    E(),
  );

const ticket = (o: { key?: string; state?: string; exp?: number } = {}) =>
  signBrokerTicket(o.key ?? ADMIN_KEY, {
    install: "i000000admin",
    state: o.state ?? "st",
    challenge: CH,
    exp: o.exp ?? Date.now() + 60_000,
  });

describe("platform-principal ticket", () => {
  it("the ids are provision's PLATFORM_PRINCIPAL_IDS", () => {
    expect([...PLATFORM_PRINCIPAL_IDS]).toEqual([...PROVISION_IDS]);
  });

  it("a valid ticket goes to Google with no hd hint, one install charge", async () => {
    const r = await authorize({ install: "i000000admin", ticket: await ticket() });
    expect(r.status).toBe(302);
    const u = new URL(r.headers.get("location") ?? "");
    expect(u.searchParams.has("hd")).toBe(false);
    expect(u.searchParams.get("prompt")).toBe("select_account");
    expect(installLimit.keys).toEqual(["authorize:install:i000000admin"]);
  });

  it("reauth=1 still adds max_age=0", async () => {
    const r = await authorize({
      install: "i000000admin",
      ticket: await ticket(),
      reauth: "1",
    });
    expect(new URL(r.headers.get("location") ?? "").searchParams.get("max_age")).toBe("0");
  });

  it("no ticket, a bad one, another flow's, another key's or an expired one: 404, no install charge", async () => {
    const bad = [
      {},
      { ticket: "junk" },
      { ticket: await ticket({ state: "other" }) },
      { ticket: await ticket({ key: OTHER_KEY }) },
      { ticket: await ticket({ exp: Date.now() - 1 }) },
      { ticket: await ticket({ exp: Date.now() + BROKER_TICKET_TTL_MS + 60_000 }) },
    ];
    for (const q of bad) {
      const r = await authorize({ install: "i000000admin", ...q });
      expect(r.status).toBe(404);
    }
    expect(installLimit.keys).toEqual([]);
  });

  it("installs need no ticket (unchanged)", async () => {
    const r = await authorize({ install: "iabcdefghijk" });
    expect(r.status).toBe(302);
    expect(installLimit.keys).toEqual(["authorize:install:iabcdefghijk"]);
  });
});
