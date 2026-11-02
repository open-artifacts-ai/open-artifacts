import { describe, expect, it } from "vitest";
import {
  APP_NAME,
  type Api,
  cliWrangler,
  deepEqual,
  LEGACY_POLICY_NAME,
  POLICY_NAME,
  parseSecretList,
  REDIRECT_URI,
  run,
  type Wrangler,
} from "./staging-access";

const ACCOUNT = "acc123";
const CLIENT_SECRET = "oidc-client-secret-value-XYZ";
const GEN = [
  "generated-session-secret-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "generated-signing-key-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
];

type Call = { method: string; path: string; body?: unknown };

type ApiOpts = {
  apps?: unknown[];
  policies?: unknown[];
  org?: unknown;
  orgFails?: boolean;
  created?: unknown;
  deleteFails?: boolean;
};

function fakeApi(opts: ApiOpts) {
  const calls: Call[] = [];
  const api: Api = async (method, path, body) => {
    calls.push({ method, path, body });
    const p = path.split("?")[0];
    if (p === `/accounts/${ACCOUNT}/access/organizations`) {
      if (opts.orgFails)
        throw new Error("GET /accounts/x/access/organizations failed (403)");
      return opts.org ?? { auth_domain: "team.cloudflareaccess.com" };
    }
    if (p === `/accounts/${ACCOUNT}/access/policies` && method === "GET")
      return opts.policies ?? [];
    if (p === `/accounts/${ACCOUNT}/access/policies` && method === "POST")
      return { id: "pol-new", name: POLICY_NAME };
    if (
      p.startsWith(`/accounts/${ACCOUNT}/access/policies/`) &&
      method === "PUT"
    )
      return { ...(body as object), id: p.split("/").pop() };
    if (p === `/accounts/${ACCOUNT}/access/apps` && method === "GET")
      return opts.apps ?? [];
    if (p === `/accounts/${ACCOUNT}/access/apps` && method === "POST")
      return (
        opts.created ?? {
          id: "app-new",
          name: APP_NAME,
          type: "saas",
          saas_app: { client_id: "cid-new", client_secret: CLIENT_SECRET },
        }
      );
    if (
      p === `/accounts/${ACCOUNT}/access/apps/app-new` &&
      method === "DELETE"
    ) {
      if (opts.deleteFails) throw new Error("DELETE app boom");
      return { id: "app-new" };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { api, calls };
}

type WOpts = { listFails?: boolean; putFails?: string };

function fakeWrangler(existing: string[], o: WOpts = {}) {
  const puts: Record<string, string> = {};
  const w: Wrangler = {
    list: async () => {
      if (o.listFails) throw new Error("wrangler list boom");
      return [...existing];
    },
    put: async (name, value) => {
      if (o.putFails === name) throw new Error(`put ${name} boom`);
      puts[name] = value;
    },
  };
  return { w, puts };
}

function harness(
  apiOpts: ApiOpts,
  existing: string[],
  extra: {
    teamName?: string;
    forceRotate?: boolean;
    configTeamDomain?: string;
    generate?: () => string;
  } & WOpts = {},
) {
  const { api, calls } = fakeApi(apiOpts);
  const { w, puts } = fakeWrangler(existing, extra);
  const logs: string[] = [];
  const summary: string[] = [];
  const masked: string[] = [];
  let g = 0;
  const go = () =>
    run({
      accountId: ACCOUNT,
      teamName: extra.teamName ?? "leourbina",
      forceRotate: extra.forceRotate ?? false,
      configTeamDomain: extra.configTeamDomain ?? "team.cloudflareaccess.com",
      api,
      wrangler: w,
      generate: extra.generate ?? (() => GEN[g++ % GEN.length] as string),
      out: {
        log: (s) => logs.push(s),
        summary: (s) => summary.push(s),
        mask: (s) => masked.push(s),
      },
    });
  return { go, calls, puts, logs, summary, masked };
}

const existingApp = {
  id: "app-1",
  name: APP_NAME,
  type: "saas",
  policies: [{ id: "pol-1", precedence: 1 }],
  saas_app: { auth_type: "oidc", client_id: "cid-existing" },
};
const SPEC = {
  name: POLICY_NAME,
  decision: "allow",
  include: [{ everyone: {} }],
  exclude: [],
  require: [],
  approval_required: false,
  isolation_required: false,
  purpose_justification_required: false,
};
const existingPolicy = { id: "pol-1", ...SPEC };
const appPuts = (calls: Call[]) =>
  calls.filter((c) => c.method === "PUT" && c.path.includes("/access/apps"));
const policyPuts = (calls: Call[]) =>
  calls.filter(
    (c) => c.method === "PUT" && c.path.includes("/access/policies/"),
  );
const ALL = ["ACCESS_CLIENT_SECRET", "SESSION_SECRET", "CONTENT_SIGNING_KEY"];
const posts = (calls: Call[]) =>
  calls.filter((c) => c.method === "POST" && c.path.endsWith("/access/apps"));

describe("staging-access", () => {
  it("creates app, policy and all secrets when absent", async () => {
    const h = harness({}, []);
    const r = await h.go();
    const pol = h.calls.find(
      (c) => c.method === "POST" && c.path.endsWith("/access/policies"),
    );
    expect(pol?.body).toEqual(SPEC);
    expect(h.logs).toContain(`policy ${POLICY_NAME}: created (pol-new)`);
    expect(posts(h.calls)[0]?.body).toEqual({
      name: APP_NAME,
      type: "saas",
      policies: [{ id: "pol-new", precedence: 1 }],
      saas_app: {
        auth_type: "oidc",
        redirect_uris: [REDIRECT_URI],
        grant_types: ["authorization_code_with_pkce"],
        allow_pkce_without_client_secret: false,
        scopes: ["openid", "email", "profile"],
      },
    });
    expect(r.clientId).toBe("cid-new");
    expect(h.puts.ACCESS_CLIENT_SECRET).toBe(CLIENT_SECRET);
    expect(h.puts.CF_ACCOUNT_ID).toBeUndefined();
    expect(h.puts.SESSION_SECRET).toBe(GEN[0]);
    expect(h.puts.CONTENT_SIGNING_KEY).toBe(GEN[1]);
    expect(h.masked).toEqual(expect.arrayContaining([CLIENT_SECRET, ...GEN]));
    expect(r.set.sort()).toEqual([...ALL].sort());
  });

  it("writes ACCESS_CLIENT_SECRET first after create", async () => {
    const order: string[] = [];
    const { api } = fakeApi({});
    await run({
      accountId: ACCOUNT,
      teamName: "x",
      forceRotate: false,
      configTeamDomain: "team.cloudflareaccess.com",
      api: async (m, p, b) => {
        if (m === "POST" && p.endsWith("/access/apps")) order.push("POST");
        return api(m, p, b);
      },
      wrangler: {
        list: async () => [],
        put: async (n) => {
          order.push(n);
        },
      },
      generate: () => GEN[0] as string,
      out: { log: () => {}, summary: () => {}, mask: () => {} },
    });
    expect(order.slice(0, 2)).toEqual(["POST", "ACCESS_CLIENT_SECRET"]);
  });

  it("deletes the new app and rethrows when a put fails after create", async () => {
    const h = harness({}, [], { putFails: "ACCESS_CLIENT_SECRET" });
    await expect(h.go()).rejects.toThrow(/put ACCESS_CLIENT_SECRET boom/);
    expect(
      h.calls.some(
        (c) =>
          c.method === "DELETE" &&
          c.path === `/accounts/${ACCOUNT}/access/apps/app-new`,
      ),
    ).toBe(true);
  });

  it("rethrows the original error and logs both when rollback DELETE fails", async () => {
    const h = harness({ deleteFails: true }, [], {
      putFails: "ACCESS_CLIENT_SECRET",
    });
    await expect(h.go()).rejects.toThrow(/put ACCESS_CLIENT_SECRET boom/);
    expect(h.logs.join("\n")).toContain(
      "rollback DELETE failed: DELETE app boom; original error: put ACCESS_CLIENT_SECRET boom",
    );
    for (const s of [CLIENT_SECRET, ...GEN])
      expect(h.logs.join("\n")).not.toContain(s);
  });

  it("does not POST when wrangler.list fails", async () => {
    const h = harness({}, [], { listFails: true });
    await expect(h.go()).rejects.toThrow(/wrangler list boom/);
    expect(posts(h.calls)).toEqual([]);
  });

  it("does not POST when a generated secret is invalid", async () => {
    const h = harness({}, [], { generate: () => "short" });
    await expect(h.go()).rejects.toThrow(/at least 32/);
    expect(posts(h.calls)).toEqual([]);
  });

  it("throws on create when the response lacks client_secret, even if the Worker has one", async () => {
    const h = harness(
      {
        created: {
          id: "app-new",
          name: APP_NAME,
          saas_app: { client_id: "cid-new" },
        },
      },
      ALL,
    );
    await expect(h.go()).rejects.toThrow(/client_secret/);
    expect(h.puts).toEqual({});
    expect(h.calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("throws on create when the response lacks client_id", async () => {
    const h = harness(
      {
        created: {
          id: "app-new",
          name: APP_NAME,
          saas_app: { client_secret: CLIENT_SECRET },
        },
      },
      [],
    );
    await expect(h.go()).rejects.toThrow(/client_id/);
  });

  it("reuses an existing app and policy, changing nothing", async () => {
    const h = harness({ apps: [existingApp], policies: [existingPolicy] }, ALL);
    const r = await h.go();
    expect(h.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(h.puts).toEqual({});
    expect(r.clientId).toBe("cid-existing");
    expect(r.skipped.sort()).toEqual([...ALL].sort());
  });

  it("policy name is the spec name", () => {
    expect(POLICY_NAME).toBe("Open Artifacts \u2013 everyone");
    expect(LEGACY_POLICY_NAME).toBe("open-artifacts-staging-owner");
  });

  it("renames the legacy owner policy to everyone in place", async () => {
    const legacy = {
      id: "pol-1",
      name: LEGACY_POLICY_NAME,
      decision: "allow",
      include: [{ email: { email: "me@test.invalid" } }],
      exclude: [],
      require: [],
    };
    const h = harness({ apps: [existingApp], policies: [legacy] }, ALL);
    await h.go();
    expect(policyPuts(h.calls)).toEqual([
      {
        method: "PUT",
        path: `/accounts/${ACCOUNT}/access/policies/pol-1`,
        body: SPEC,
      },
    ]);
    expect(h.calls.some((c) => c.method === "POST")).toBe(false);
    expect(h.logs).toContain(`policy ${POLICY_NAME}: reconciled (pol-1)`);
    expect(appPuts(h.calls)).toEqual([]);
  });

  it("fixes a drifted include on the everyone policy", async () => {
    const drifted = {
      ...existingPolicy,
      include: [{ email: { email: "x@y.z" } }],
    };
    const h = harness({ apps: [existingApp], policies: [drifted] }, ALL);
    await h.go();
    expect(policyPuts(h.calls).map((c) => c.body)).toEqual([SPEC]);
    expect(h.logs).toContain(`policy ${POLICY_NAME}: reconciled (pol-1)`);
  });

  it("carries over session_duration when reconciling", async () => {
    const legacy = {
      id: "pol-1",
      name: LEGACY_POLICY_NAME,
      decision: "allow",
      include: [{ email: { email: "me@test.invalid" } }],
      session_duration: "24h",
      approval_required: true,
      approval_groups: [{ email_addresses: ["a@b.c"] }],
      created_at: "2026-01-01",
    };
    const h = harness({ apps: [existingApp], policies: [legacy] }, ALL);
    await h.go();
    expect(policyPuts(h.calls).map((c) => c.body)).toEqual([
      { session_duration: "24h", ...SPEC },
    ]);
  });

  it("reconciles drift in approval/isolation/purpose_justification", async () => {
    for (const k of [
      "approval_required",
      "isolation_required",
      "purpose_justification_required",
    ]) {
      const h = harness(
        { apps: [existingApp], policies: [{ ...existingPolicy, [k]: true }] },
        ALL,
      );
      await h.go();
      expect(policyPuts(h.calls).map((c) => c.body)).toEqual([SPEC]);
    }
  });

  it("compares include by deep equality, not key order", () => {
    expect(
      deepEqual([{ a: 1, b: { c: 2, d: 3 } }], [{ b: { d: 3, c: 2 }, a: 1 }]),
    ).toBe(true);
    expect(deepEqual([{ everyone: {} }], [{ everyone: { x: 1 } }])).toBe(false);
    expect(deepEqual([{ a: 1 }], [{ a: 1 }, { a: 1 }])).toBe(false);
    expect(deepEqual({}, [])).toBe(false);
  });

  it("fixes a drifted decision or require", async () => {
    for (const d of [
      { ...existingPolicy, decision: "deny" },
      { ...existingPolicy, require: [{ email: { email: "x@y.z" } }] },
    ]) {
      const h = harness({ apps: [existingApp], policies: [d] }, ALL);
      await h.go();
      expect(policyPuts(h.calls).length).toBe(1);
    }
  });

  it("prefers the new name when both exist and leaves legacy alone", async () => {
    const h = harness(
      {
        apps: [existingApp],
        policies: [
          { id: "pol-legacy", name: LEGACY_POLICY_NAME },
          existingPolicy,
        ],
      },
      ALL,
    );
    await h.go();
    expect(policyPuts(h.calls)).toEqual([]);
  });

  it("is unchanged when the everyone policy is correct (absent exclude/require ok)", async () => {
    const h = harness(
      {
        apps: [existingApp],
        policies: [
          {
            id: "pol-1",
            name: POLICY_NAME,
            decision: "allow",
            include: [{ everyone: {} }],
          },
        ],
      },
      ALL,
    );
    await h.go();
    expect(h.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(h.logs).toContain(`policy ${POLICY_NAME}: unchanged (pol-1)`);
  });

  it("never PUTs the app in any policy scenario", async () => {
    for (const policies of [
      [],
      [
        {
          id: "pol-1",
          name: LEGACY_POLICY_NAME,
          decision: "allow",
          include: [],
        },
      ],
      [{ ...existingPolicy, include: [] }],
      [existingPolicy],
    ]) {
      const h = harness({ apps: [existingApp], policies }, ALL);
      await h.go().catch(() => {});
      expect(appPuts(h.calls)).toEqual([]);
    }
    const fresh = harness({}, []);
    await fresh.go();
    expect(appPuts(fresh.calls)).toEqual([]);
  });

  it("fails clearly when an existing app lacks the everyone policy, without PUT", async () => {
    const h = harness(
      { apps: [{ ...existingApp, policies: [] }], policies: [existingPolicy] },
      ALL,
    );
    await expect(h.go()).rejects.toThrow(
      new RegExp(`attach ${POLICY_NAME}.*dashboard.*delete the app`, "s"),
    );
    expect(h.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(h.puts).toEqual({});
  });

  it("uses auth_domain from the organization", async () => {
    const r = await harness(
      { apps: [existingApp], policies: [existingPolicy] },
      ALL,
    ).go();
    expect(r.teamDomain).toBe("team.cloudflareaccess.com");
  });

  it("falls back to the team_name input and logs the HTTP status", async () => {
    const h = harness(
      { orgFails: true, apps: [existingApp], policies: [existingPolicy] },
      ALL,
      { teamName: "acme" },
    );
    const a = await h.go();
    expect(a.teamDomain).toBe("acme.cloudflareaccess.com");
    expect(h.logs.join("\n")).toMatch(/organizations.*403/);
    const b = await harness(
      {
        org: { auth_domain: "" },
        apps: [existingApp],
        policies: [existingPolicy],
      },
      ALL,
      { teamName: "acme" },
    ).go();
    expect(b.teamDomain).toBe("acme.cloudflareaccess.com");
  });

  it("warns in the summary when the team domain differs from config", async () => {
    const h = harness(
      { apps: [existingApp], policies: [existingPolicy] },
      ALL,
      { configTeamDomain: "other.cloudflareaccess.com" },
    );
    await h.go();
    expect(h.summary.join("\n")).toMatch(
      /warning.*team\.cloudflareaccess\.com.*other\.cloudflareaccess\.com/is,
    );
    const ok = harness(
      { apps: [existingApp], policies: [existingPolicy] },
      ALL,
    );
    await ok.go();
    expect(ok.summary.join("\n")).not.toMatch(/warning/i);
  });

  it("skips secrets already set and sets only missing ones", async () => {
    const h = harness({ apps: [existingApp], policies: [existingPolicy] }, [
      "ACCESS_CLIENT_SECRET",
      "SESSION_SECRET",
    ]);
    const r = await h.go();
    expect(Object.keys(h.puts)).toEqual(["CONTENT_SIGNING_KEY"]);
    expect(r.skipped.sort()).toEqual([
      "ACCESS_CLIENT_SECRET",
      "SESSION_SECRET",
    ]);
  });

  it("force_rotate regenerates session and signing keys only", async () => {
    const h = harness(
      { apps: [existingApp], policies: [existingPolicy] },
      ALL,
      {
        forceRotate: true,
      },
    );
    await h.go();
    expect(Object.keys(h.puts).sort()).toEqual([
      "CONTENT_SIGNING_KEY",
      "SESSION_SECRET",
    ]);
  });

  it("never writes a secret value to stdout or the summary", async () => {
    const h = harness({}, []);
    await h.go();
    const text = [...h.logs, ...h.summary].join("\n");
    for (const s of [CLIENT_SECRET, ...GEN]) expect(text).not.toContain(s);
    const sum = h.summary.join("\n");
    expect(sum).toContain("ACCESS_CLIENT_ID");
    expect(sum).toContain("cid-new");
    expect(sum).toContain("ACCESS_TEAM_DOMAIN");
    expect(sum).toContain("team.cloudflareaccess.com");
    for (const n of ALL) expect(sum).toContain(n);
  });

  it("fails clearly when the app exists and the client secret is unrecoverable", async () => {
    const h = harness({ apps: [existingApp], policies: [existingPolicy] }, []);
    await expect(h.go()).rejects.toThrow(
      /ACCESS_CLIENT_SECRET.*cannot be recovered/s,
    );
    expect(h.puts).toEqual({});
  });
});

describe("parseSecretList", () => {
  it("is used by cliWrangler.list", () => {
    expect(cliWrangler.list.toString()).toContain("parseSecretList");
  });
  it("parses JSON after a banner", () => {
    expect(
      parseSecretList('banner\n[{"name":"A","type":"secret_text"}]'),
    ).toEqual(["A"]);
  });
  it("fails clearly when output has no JSON array", () => {
    expect(() => parseSecretList("Not authenticated")).toThrow(
      /wrangler secret list.*no JSON array/,
    );
  });
});
