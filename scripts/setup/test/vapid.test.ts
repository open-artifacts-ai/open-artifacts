import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { generateVapidPair } from "../src/vapid.ts";
import { ROOT } from "./fakes.ts";
import { app, HOSTS, POLICY, world } from "./world.ts";

type W = ReturnType<typeof world>;
const CORE = ["ACCESS_CLIENT_SECRET", "SESSION_SECRET", "CONTENT_SIGNING_KEY"];
const PUB = "VAPID_PUBLIC_KEY";
const PRIV = "VAPID_PRIVATE_KEY";
const VARS = {
  ENVIRONMENT: "production",
  APP_HOST: "app.example.com",
  CONTENT_HOST: "a.b.usercontent.example.com",
  OWNER_EMAIL: "owner@example.com",
  ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
  ACCESS_CLIENT_ID: "cid-open-artifacts",
};
const UPGRADE = ["--name", "open-artifacts", "--yes", "--json", "--upgrade"];
const cloud = (secrets: string[]) =>
  world({
    d1: [{ uuid: "d1-live", name: "open-artifacts" }],
    r2: [{ name: "open-artifacts" }],
    kv: [{ id: "kv-live", title: "open-artifacts-oauth" }],
    policies: [POLICY],
    apps: [app("open-artifacts")],
    secrets,
    worker: VARS,
    seed: {
      users: [{ id: "u-owner", email: "owner@example.com", role: "owner" }],
    },
  });
const ready = (w: W) => {
  w.deps.env.OA_ACCESS_TOKEN = "oa-ci";
  return w;
};
const puts = (w: W) => w.ops.filter((o) => o.startsWith("put "));

// Loaded by path: a static import would pull the Worker server code into the
// scripts typecheck, which has no Worker types.
const WEB_PUSH = new URL(
  "../../../apps/server/src/services/web-push.ts",
  import.meta.url,
).href;
type VapidHeader = (
  env: Record<string, string>,
  endpoint: string,
) => Promise<string>;
const loadVapidHeader = async () =>
  ((await import(/* @vite-ignore */ WEB_PUSH)) as { vapidHeader: VapidHeader })
    .vapidHeader;

describe("OA_SETUP_PUSH_KEYS=off", () => {
  const off = (w: W) => {
    w.deps.env.OA_SETUP_PUSH_KEYS = "off";
    return ready(w);
  };
  it("touches no VAPID secret on upgrade, and a half pair does not block it", async () => {
    for (const have of [CORE, [...CORE, PUB]]) {
      const w = off(cloud(have));
      expect(await run(UPGRADE, w.deps, ROOT)).toBe(0);
      expect(puts(w)).toEqual([]);
      const j = w.lines
        .map((l) => JSON.parse(l))
        .find((x) => x.step === "secrets");
      expect(j.status).not.toBe("action_required");
    }
  });
  it("on (unset), generates once: a second upgrade puts nothing", async () => {
    const w = ready(cloud(CORE));
    await run(UPGRADE, w.deps, ROOT);
    expect(puts(w)).toHaveLength(2);
    w.ops.length = 0;
    await run(UPGRADE, w.deps, ROOT);
    expect(puts(w)).toEqual([]);
  });
});

describe("self-host push keys (VAPID)", () => {
  it("a lone private key is replaced without asking", async () => {
    const w = ready(cloud([...CORE, PRIV]));
    expect(await run(UPGRADE, w.deps, ROOT)).toBe(0);
    expect(puts(w)).toEqual([`put ${PRIV}`, `put ${PUB}`]);
  });

  it("a run cut off after the private key finishes on rerun", async () => {
    const cfg: NonNullable<Parameters<typeof world>[0]> = {
      d1: [{ uuid: "d1-live", name: "open-artifacts" }],
      r2: [{ name: "open-artifacts" }],
      kv: [{ id: "kv-live", title: "open-artifacts-oauth" }],
      policies: [POLICY],
      apps: [app("open-artifacts")],
      secrets: CORE,
      worker: VARS,
      seed: {
        users: [{ id: "u-owner", email: "owner@example.com", role: "owner" }],
      },
      putFails: PUB,
    };
    const w = ready(world(cfg));
    expect(await run(UPGRADE, w.deps, ROOT)).not.toBe(0);
    expect(puts(w)).toEqual([`put ${PRIV}`]);
    cfg.putFails = undefined;
    expect(await run(UPGRADE, w.deps, ROOT)).toBe(0);
    expect(puts(w)).toEqual([`put ${PRIV}`, `put ${PRIV}`, `put ${PUB}`]);
    w.ops.length = 0;
    expect(await run(UPGRADE, w.deps, ROOT)).toBe(0);
    expect(puts(w)).toEqual([]);
  });

  it("generates the pair on upgrade when the Worker lacks it", async () => {
    const w = ready(cloud(CORE));
    expect(await run(UPGRADE, w.deps, ROOT)).toBe(0);
    expect(puts(w)).toEqual([`put ${PRIV}`, `put ${PUB}`]);
  });

  it("generates the pair on a first full setup", async () => {
    const w = world();
    await run(HOSTS, w.deps, ROOT);
    expect(puts(w)).toContain(`put ${PUB}`);
    expect(puts(w)).toContain(`put ${PRIV}`);
  });

  it("keeps an existing pair: no put, no rotation", async () => {
    const w = ready(cloud([...CORE, PUB, PRIV]));
    expect(await run(UPGRADE, w.deps, ROOT)).toBe(0);
    expect(puts(w)).toEqual([]);
  });

  it.each([PUB])(
    "refuses a lone public key (%s) and writes nothing",
    async (only) => {
      const w = ready(cloud([...CORE, only]));
      await run(UPGRADE, w.deps, ROOT);
      expect(puts(w)).toEqual([]);
      const j = w.lines
        .map((l) => JSON.parse(l))
        .find((x) => x.step === "secrets");
      expect(j.status).toBe("action_required");
      expect(j.message).toContain("half a push key pair");
      expect(j.message).toContain(only);
    },
  );

  it("never prints key material, writes it to a file, or puts it in argv", async () => {
    const w = ready(cloud(CORE));
    await run(UPGRADE, w.deps, ROOT);
    const keys = w.values.slice(-2);
    expect(keys).toHaveLength(2);
    const haystack = [...w.lines, ...w.prompts, ...w.files.values()].join("\n");
    for (const k of keys) expect(haystack).not.toContain(k);
    expect(w.ops.join("\n")).not.toContain(keys[0]);
    expect(w.ops.join("\n")).not.toContain(keys[1]);
  });

  it("the generated pair signs a VAPID JWT that verifies against the public key", async () => {
    const { publicKey, privateKey } = await generateVapidPair();
    expect(Buffer.from(publicKey, "base64url")).toHaveLength(65);
    expect(Buffer.from(privateKey, "base64url")).toHaveLength(32);
    const header = await (await loadVapidHeader())(
      {
        VAPID_PUBLIC_KEY: publicKey,
        VAPID_PRIVATE_KEY: privateKey,
        APP_HOST: "app.example.com",
      },
      "https://push.example.net/send/abc",
    );
    const m = header.match(/^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=(.+)$/);
    expect(m).not.toBeNull();
    const [, h, c, sig, k] = m as RegExpMatchArray;
    expect(k).toBe(publicKey);
    const key = await crypto.subtle.importKey(
      "raw",
      Buffer.from(publicKey, "base64url"),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      Buffer.from(sig, "base64url"),
      new TextEncoder().encode(`${h}.${c}`),
    );
    expect(ok).toBe(true);
  });
});
