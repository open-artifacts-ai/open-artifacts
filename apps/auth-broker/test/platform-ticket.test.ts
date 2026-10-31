import { env } from "cloudflare:workers";
import {
  BROKER_TICKET_TTL_MS,
  flowHash,
  GOOGLE_TOKEN_URL,
  keyId,
  PLATFORM_PRINCIPAL_IDS,
  publicFromPkcs8,
  signBrokerTicket,
  signRedeem,
} from "@oa/auth-core";
import { PLATFORM_PRINCIPAL_IDS as PROVISION_IDS } from "@oa/provision/names";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/** A fake binding; each key allows `max` hits. */
const limiter = (max = Number.POSITIVE_INFINITY) => {
  const keys: string[] = [];
  return {
    keys,
    limit: async ({ key }: { key: string }) => (
      keys.push(key), { success: keys.filter((k) => k === key).length <= max }
    ),
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

const authorize = (q: Record<string, string>, ip = "198.51.100.7") =>
  broker.fetch(
    new Request(
      `${BROKER}/google/authorize?${new URLSearchParams({ state: "st", nonce: "n", code_challenge: CH, ...q })}`,
      { headers: { "cf-connecting-ip": ip } },
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

  it("a valid ticket goes to Google with no hd hint, one install charge on the client's key", async () => {
    const r = await authorize({
      install: "i000000admin",
      ticket: await ticket(),
    });
    expect(r.status).toBe(302);
    const u = new URL(r.headers.get("location") ?? "");
    expect(u.searchParams.has("hd")).toBe(false);
    expect(u.searchParams.get("prompt")).toBe("select_account");
    expect(installLimit.keys).toEqual([
      "authorize:ip:198.51.100.7:install:i000000admin",
    ]);
  });

  it("replaying one ticket drains only the replayer's key (IPv6 by /64), never a shared bucket", async () => {
    installLimit = limiter(3);
    const t = await ticket();
    const from = (ip: string) =>
      authorize({ install: "i000000admin", ticket: t }, ip);
    for (let i = 0; i < 3; i++)
      expect((await from(`2001:db8:1:2::${i + 1}`)).status).toBe(302);
    // The same /64 is one key: the 4th replay is refused.
    expect((await from("2001:db8:1:2::ff")).status).toBe(429);
    // Another client still signs in with the same ticket.
    expect((await from("203.0.113.9")).status).toBe(302);
    expect(installLimit.keys).not.toContain("authorize:install:i000000admin");
    expect(new Set(installLimit.keys)).toEqual(
      new Set([
        "authorize:ip:2001:db8:1:2::/64:install:i000000admin",
        "authorize:ip:203.0.113.9:install:i000000admin",
      ]),
    );
  });

  it("reauth=1 still adds max_age=0", async () => {
    const r = await authorize({
      install: "i000000admin",
      ticket: await ticket(),
      reauth: "1",
    });
    expect(
      new URL(r.headers.get("location") ?? "").searchParams.get("max_age"),
    ).toBe("0");
  });

  it("no ticket, a bad one, another flow's, another key's or an expired one: 404, no install charge", async () => {
    const bad: Record<string, string>[] = [
      {},
      { ticket: "junk" },
      { ticket: await ticket({ state: "other" }) },
      { ticket: await ticket({ key: OTHER_KEY }) },
      { ticket: await ticket({ exp: Date.now() - 1 }) },
      {
        ticket: await ticket({
          exp: Date.now() + BROKER_TICKET_TTL_MS + 60_000,
        }),
      },
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

describe("platform-principal redeem", () => {
  let tokenCalls = 0;
  beforeEach(() => {
    tokenCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      if (req.url !== GOOGLE_TOKEN_URL)
        throw new Error(`unexpected fetch ${req.url}`);
      tokenCalls++;
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  /** A broker state for the admin flow `state`, as authorize mints it. */
  async function bstateFor(state: string) {
    const r = await authorize({
      install: "i000000admin",
      state,
      ticket: await ticket({ state }),
    });
    return (
      new URL(r.headers.get("location") ?? "").searchParams.get("state") ?? ""
    );
  }

  // The admin's redeem reaches the broker over a service binding with no
  // cf-connecting-ip, so it carries the gate header (4.3 step 3).
  async function redeem(bstate: string, h?: string) {
    const kid = await keyId(await publicFromPkcs8(ADMIN_KEY));
    const text = JSON.stringify({
      install: "i000000admin",
      code: "x",
      verifier: "v",
      ts: Date.now(),
      bstate,
      h: h ?? (await flowHash("n", CH)),
    });
    return broker.fetch(
      new Request(`${BROKER}/google/redeem`, {
        method: "POST",
        headers: {
          "x-oa-kid": kid,
          "x-oa-sig": await signRedeem(ADMIN_KEY, kid, text),
          "x-oa-gate-install": "i000000admin",
          "content-type": "application/json",
        },
        body: text,
      }) as never,
      E(),
    );
  }

  it("a bad flow is refused before the install bucket is charged", async () => {
    const bs = await bstateFor("st");
    installLimit = limiter();
    for (const r of [
      await redeem("x"),
      await redeem(bs, await flowHash("other", CH)),
    ])
      expect(r.status).toBe(401);
    expect(installLimit.keys).toEqual([]);
    expect(tokenCalls).toBe(0);
  });

  it("junk-bstate redeems through the gate never drain the shared gate bucket: the real redeem still succeeds", async () => {
    const admin = await bstateFor("admin");
    ipLimit = limiter(3);
    installLimit = limiter(3);
    for (let i = 0; i < 6; i++)
      expect((await redeem(`junk-${i}`)).status).toBe(401);
    expect((await redeem(admin)).status).toBe(400);
    expect(tokenCalls).toBe(1);
    expect(ipLimit.keys).not.toContain("gate:i000000admin");
    expect(installLimit.keys).toEqual([
      expect.stringMatching(/^redeem:.+:install:i000000admin$/),
    ]);
  });

  it("a public redeem naming a platform id is still charged per IP first", async () => {
    ipLimit = limiter(0);
    const r = await broker.fetch(
      new Request(`${BROKER}/google/redeem`, {
        method: "POST",
        headers: { "cf-connecting-ip": "198.51.100.9" },
        body: JSON.stringify({
          install: "i000000admin",
          code: "x",
          verifier: "v",
          ts: Date.now(),
          bstate: "junk",
          h: "h",
        }),
      }) as never,
      E(),
    );
    expect(r.status).toBe(429);
    expect(ipLimit.keys).toEqual(["ip:198.51.100.9"]);
  });

  it("the install bucket is per flow: replaying one flow's redeem never drains another's", async () => {
    const mine = await bstateFor("attacker");
    const admin = await bstateFor("admin");
    installLimit = limiter(3);
    for (let i = 0; i < 3; i++) expect((await redeem(mine)).status).toBe(400);
    expect((await redeem(mine)).status).toBe(429);
    // The admin's own flow still reaches Google.
    expect((await redeem(admin)).status).toBe(400);
    expect(tokenCalls).toBe(4);
    expect(installLimit.keys).not.toContain("redeem:install:i000000admin");
  });
});
