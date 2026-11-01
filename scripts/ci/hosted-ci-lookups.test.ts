// The hosted CI lookups with the one Cloudflare token: the resource ids
// (hosted-resource-ids.sh), the Turnstile keys (hosted-turnstile-keys.sh) and
// the R2 key (hosted-r2-key.sh). Each resolves by exact name, exactly one,
// pages through every listing, and fails closed on any error. curl is a stub;
// the token reaches it on stdin only.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { root, sandbox, script } from "./stubs.ts";

const TOK = "cfut_TOKEN_never_printed_0123456789";
const ACCT = "26ac346086d4405f7a976d48747a2a75";
const UUID = "0d6a2a8e-1c2b-4c3d-8e4f-5a6b7c8d9e0f";
const ZONE = "9".repeat(32);
const STORE = "5".repeat(32);
const KV = {
  hosts: "a".repeat(32),
  broker: "b".repeat(32),
  directory: "c".repeat(32),
};

/** One fixture page: a body, NETERR (curl fails) or FAIL (success: false). */
type Page = unknown;
const ok = (result: unknown, info?: Record<string, unknown>) =>
  JSON.stringify({
    success: true,
    errors: [],
    result,
    ...(info ? { result_info: info } : {}),
  });

// curl: $STATE/<kind>-<page> holds the body (or NETERR); kind from the path.
const curl = `cfg="$(cat)"
case "$cfg" in *"$TOK_EXPECT"*) ;; *) echo '{"success":false,"errors":[{"message":"bad token"}]}'; exit 0 ;; esac
url="\${@: -1}"; path="\${url#https://api.cloudflare.com/client/v4}"
page=1; case "$path" in *page=*) page="\${path##*page=}" ;; esac
case "$path" in
  "/accounts/$STUB_ACCT/d1/database?per_page=100&page="*) k=d1 ;;
  "/accounts/$STUB_ACCT/storage/kv/namespaces?per_page=100&page="*) k=kv ;;
  "/accounts/$STUB_ACCT/secrets_store/stores?per_page=100&page="*) k=stores ;;
  "/accounts/$STUB_ACCT/challenges/widgets?per_page=50&page="*) k=widgets ;;
  "/accounts/$STUB_ACCT/challenges/widgets/"*) k=widget ;;
  "/zones?name=$EMAIL_ZONE&account.id=$STUB_ACCT&per_page=50&page="*) k=zones ;;
  /user/tokens/verify) k=verify ;;
  *) echo "UNEXPECTED $path" >> "$STUB_LOG"; echo '{"success":false}'; exit 0 ;;
esac
f="$STATE/$k-$page"
[ -f "$f" ] || { echo '{"success":false,"errors":[{"message":"no fixture"}]}'; exit 0; }
[ "$(cat "$f")" = NETERR ] && { echo "curl: (6) Could not resolve host" >&2; exit 6; }
cat "$f"`;

const run = (
  cmd: string[],
  fx: Record<string, Page[]>,
  env: Record<string, string> = {},
) => {
  const sb = sandbox({ curl });
  for (const [k, pages] of Object.entries(fx))
    for (const [i, p] of pages.entries())
      writeFileSync(
        join(sb.dir, `${k}-${i + 1}`),
        typeof p === "string" ? p : JSON.stringify(p),
      );
  const ghEnv = join(sb.dir, "github-env");
  writeFileSync(ghEnv, "");
  const r = sb.run(cmd, {
    env: {
      STATE: sb.dir,
      CLOUDFLARE_API_TOKEN: TOK,
      TOK_EXPECT: TOK,
      CLOUDFLARE_ACCOUNT_ID: ACCT,
      STUB_ACCT: ACCT,
      GITHUB_ENV: ghEnv,
      EMAIL_ZONE: "open-artifacts.app",
      ...env,
    },
  });
  const all = [r.out, r.err, ...sb.log()].join("\n");
  expect(all).not.toContain(TOK);
  return { ...r, dir: sb.dir, ghEnv: readFileSync(ghEnv, "utf8"), sb };
};

describe("hosted-resource-ids.sh", () => {
  const d1 = (extra: unknown[] = []) => [
    { uuid: "11111111-1111-4111-8111-111111111111", name: "oa-p-platform-old" },
    { uuid: UUID, name: "oa-p-platform" },
    { uuid: "22222222-2222-4222-8222-222222222222", name: "oa-s-platform" },
    ...extra,
  ];
  const kv = (extra: unknown[] = []) => [
    { id: KV.hosts, title: "oa-p-hosts" },
    { id: KV.broker, title: "oa-p-broker-registry" },
    { id: KV.directory, title: "oa-p-directory-registry" },
    { id: "d".repeat(32), title: "oa-s-hosts" },
    { id: "e".repeat(32), title: "oa-p-hosts-2" },
    ...extra,
  ];
  const mine = { account: { id: ACCT } };
  const zones = (extra: unknown[] = []) => [
    { id: ZONE, name: "open-artifacts.app", ...mine },
    // Same name on another account: never ours.
    {
      id: "8".repeat(32),
      name: "open-artifacts.app",
      account: { id: "7".repeat(32) },
    },
    ...extra,
  ];
  // The account's Secrets Store (the provisioner's PROVISION_TOKEN lives there).
  const stores = (extra: unknown[] = []) => [
    { id: STORE, name: "default_secrets_store" },
    { id: "6".repeat(32), name: "other_store" },
    ...extra,
  ];
  const lists: Record<string, (extra?: unknown[]) => unknown[]> = {
    d1,
    kv,
    zones,
    stores,
  };
  const good = () => ({
    d1: [ok(d1(), { total_pages: 1 })],
    kv: [ok(kv(), { total_pages: 1 })],
    zones: [ok(zones(), { total_pages: 1 })],
    stores: [ok(stores(), { total_pages: 1 })],
  });
  const ids = (o: Record<string, Page[]> = good(), env = "prod") =>
    run(["bash", script("hosted-resource-ids.sh"), env], o);
  const WANT = [
    `PLATFORM_DB_ID=${UUID}`,
    `HOSTS_KV_ID=${KV.hosts}`,
    `BROKER_REGISTRY_ID=${KV.broker}`,
    `DIRECTORY_REGISTRY_ID=${KV.directory}`,
    `EMAIL_ZONE_TAGS=${ZONE}`,
    `SECRETS_STORE_ID=${STORE}`,
    "",
  ].join("\n");

  it("resolves all six by exact name on the account and writes them to GITHUB_ENV", () => {
    const r = ids();
    expect(r.code, r.err).toBe(0);
    expect(r.ghEnv).toBe(WANT);
    expect(r.out).toContain(`oa-p-platform: ${UUID}`);
  });

  it("staging resolves the oa-s- names", () => {
    const r = ids(
      {
        d1: [ok([{ uuid: UUID, name: "oa-s-platform" }])],
        kv: [
          ok([
            { id: KV.hosts, title: "oa-s-hosts" },
            { id: KV.broker, title: "oa-s-broker-registry" },
            { id: KV.directory, title: "oa-s-directory-registry" },
          ]),
        ],
        zones: [ok(zones())],
        stores: [ok(stores())],
      },
      "staging",
    );
    expect(r.code, r.err).toBe(0);
    expect(r.ghEnv).toBe(WANT);
  });

  it("pages through both listings (total_pages, or a full page without it)", () => {
    const full = (n: number, prefix: string) =>
      Array.from({ length: n }, (_, i) => ({
        uuid: `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`,
        id: `${String(i).padStart(32, "0")}`,
        name: `${prefix}${i}`,
        title: `${prefix}${i}`,
      }));
    // D1: total_pages says 3; page 2 is short (clamped) and still not the end.
    // KV: no result_info; page 1 is a full 100, page 2 short ends it.
    const r = ids({
      d1: [
        ok(full(100, "x-"), { total_pages: 3 }),
        ok(full(3, "y-"), { total_pages: 3 }),
        ok(d1(), { total_pages: 3 }),
      ],
      kv: [ok(full(100, "z-")), ok(kv())],
      zones: [ok(zones())],
      stores: [ok(stores())],
    });
    expect(r.code, r.err).toBe(0);
    expect(r.ghEnv).toBe(WANT);
    const urls = r.sb.log().filter((l) => l.startsWith("curl "));
    expect(urls.filter((u) => u.includes("/d1/database?"))).toHaveLength(3);
    expect(urls.filter((u) => u.includes("/kv/namespaces?"))).toHaveLength(2);
    // The token never reaches argv: curl gets the config on stdin.
    for (const u of urls) expect(u).toMatch(/^curl -sS -K - https:\/\//);
  });

  const RESOURCES: [
    string,
    "d1" | "kv" | "zones" | "stores",
    string,
    string,
    string,
  ][] = [
    ["oa-p-platform", "d1", "name", "uuid", UUID],
    ["oa-p-hosts", "kv", "title", "id", KV.hosts],
    ["oa-p-broker-registry", "kv", "title", "id", KV.broker],
    ["oa-p-directory-registry", "kv", "title", "id", KV.directory],
    ["open-artifacts.app", "zones", "name", "id", ZONE],
    ["default_secrets_store", "stores", "name", "id", STORE],
  ];

  for (const [name, kind, nameKey, idKey, id] of RESOURCES) {
    it(`${name}: none found fails, naming it, and writes nothing`, () => {
      const o = good();
      const list = lists[kind]().filter(
        (x) => (x as Record<string, string>)[nameKey] !== name,
      );
      o[kind] = [ok(list, { total_pages: 1 })];
      const r = ids(o);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`${name}: 0 found, want exactly one`);
      expect(r.ghEnv).toBe("");
    });

    it(`${name}: two found (even on different pages) fails, naming it`, () => {
      const o = good();
      const dup = { [nameKey]: name, [idKey]: id, ...mine };
      o[kind] = [
        ok(lists[kind](), { total_pages: 2 }),
        ok([dup], { total_pages: 2 }),
      ];
      const r = ids(o);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`${name}: 2 found, want exactly one`);
      expect(r.ghEnv).toBe("");
    });

    it(`${name}: a failed listing or a network error fails, naming it`, () => {
      for (const bad of [
        JSON.stringify({ success: false, errors: [{ code: 10000 }] }),
        "NETERR",
        "not json",
      ]) {
        const o = good();
        // The failure is on the listing's second page.
        o[kind] = [ok(lists[kind](), { total_pages: 2 }), bad];
        const r = ids(o);
        expect(r.code, bad).toBe(1);
        expect(r.err).toContain(name);
        expect(r.err).toContain("failed");
        expect(r.ghEnv).toBe("");
      }
    });
  }

  // Guard: the tag derived from the committed email_zone must equal the last
  // known one. Read back 2026-10-30: prod open-artifacts.app is
  // eb90975c0a329d0c743fa4f33f917934, and staging open-artifacts-staging.app is
  // ac9bf5324b302ca21082b8b4751e5e1b, which is the deployed oa-s-scheduler's
  // EMAIL_QUOTA_ZONES. The lookup is stubbed with those zones (and decoys).
  it("the derived sending zone tag is the last known one, per env", () => {
    const KNOWN = {
      prod: {
        zone: "open-artifacts.app",
        tag: "eb90975c0a329d0c743fa4f33f917934",
      },
      staging: {
        zone: "open-artifacts-staging.app",
        tag: "ac9bf5324b302ca21082b8b4751e5e1b",
      },
    } as const;
    const p = (env: string) => (env === "prod" ? "p" : "s");
    for (const env of ["prod", "staging"] as const) {
      const committed = JSON.parse(
        readFileSync(join(root, `.github/hosted/${env}.json`), "utf8"),
      ) as { email_zone: string };
      expect(committed.email_zone, env).toBe(KNOWN[env].zone);
      const zoneList = [
        { id: KNOWN.prod.tag, name: KNOWN.prod.zone, ...mine },
        { id: KNOWN.staging.tag, name: KNOWN.staging.zone, ...mine },
        { id: "1".repeat(32), name: "open-artifacts.page", ...mine },
      ];
      const r = run(
        ["bash", script("hosted-resource-ids.sh"), env],
        {
          d1: [ok([{ uuid: UUID, name: `oa-${p(env)}-platform` }])],
          kv: [
            ok([
              { id: KV.hosts, title: `oa-${p(env)}-hosts` },
              { id: KV.broker, title: `oa-${p(env)}-broker-registry` },
              { id: KV.directory, title: `oa-${p(env)}-directory-registry` },
            ]),
          ],
          zones: [ok(zoneList)],
          stores: [ok(stores())],
        },
        { EMAIL_ZONE: committed.email_zone },
      );
      expect(r.code, r.err).toBe(0);
      expect(r.ghEnv, env).toContain(`EMAIL_ZONE_TAGS=${KNOWN[env].tag}\n`);
    }
  });

  it("the Secrets Store only for provision-token or provisioner: other targets never list it", () => {
    for (const TARGETS of [
      "auth-broker,dispatch,scheduler,inventory,provisioning",
      "zones",
    ]) {
      const o = good();
      o.stores = ["NETERR"];
      const r = run(["bash", script("hosted-resource-ids.sh"), "prod"], o, {
        TARGETS,
      });
      expect(r.code, r.err).toBe(0);
      expect(r.ghEnv).toBe(WANT.replace(`SECRETS_STORE_ID=${STORE}\n`, ""));
      expect(r.sb.log().some((l) => l.includes("secrets_store"))).toBe(false);
    }
    for (const TARGETS of [
      "provision-token",
      "platform-db,provisioner,provisioning",
    ]) {
      const r = run(
        ["bash", script("hosted-resource-ids.sh"), "prod"],
        good(),
        { TARGETS },
      );
      expect(r.code, r.err).toBe(0);
      expect(r.ghEnv).toBe(WANT);
    }
  });

  it("the sending zone: a zone of that name on another account never counts", () => {
    const o = good();
    o.zones = [ok(zones().slice(1))];
    const r = ids(o);
    expect(r.code).toBe(1);
    expect(r.err).toContain(
      "zone open-artifacts.app: 0 found, want exactly one",
    );
    expect(r.ghEnv).toBe("");
    // The query is account-scoped too.
    expect(
      r.sb
        .log()
        .some((l) =>
          l.includes(`/zones?name=open-artifacts.app&account.id=${ACCT}&`),
        ),
    ).toBe(true);
  });

  it("refuses an id of the wrong shape, a bad env and a bad account id", () => {
    const o = good();
    o.kv = [
      ok(
        kv().map((x) =>
          (x as { title: string }).title === "oa-p-hosts"
            ? { ...(x as object), id: "not-hex" }
            : x,
        ),
      ),
    ];
    expect(ids(o).code).toBe(1);
    expect(ids(good(), "dev").code).toBe(2);
    const r = run(["bash", script("hosted-resource-ids.sh"), "prod"], good(), {
      CLOUDFLARE_ACCOUNT_ID: "nope",
    });
    expect(r.code).toBe(2);
    expect(r.ghEnv).toBe("");
  });
});

describe("hosted-turnstile-keys.sh", () => {
  const SK = "0x4AAAAAAA0123456789";
  const widgets = (extra: unknown[] = []) => [
    { sitekey: "0x4other", name: "oa-s-turnstile" },
    { sitekey: SK, name: "oa-p-turnstile" },
    { sitekey: "0x4third", name: "oa-p-turnstile-old" },
    ...extra,
  ];
  const keys = (
    o: Record<string, Page[]> = {
      widgets: [ok(widgets(), { total_pages: 1 })],
      widget: [ok({ sitekey: SK, secret: "SECRETturnstile" })],
    },
  ) => {
    const r = run(
      ["bash", script("hosted-turnstile-keys.sh"), "prod", "OUT"],
      o,
    );
    const out = join(r.dir, "OUT");
    return {
      ...r,
      file: existsSync(out) ? readFileSync(out, "utf8") : null,
      path: out,
    };
  };
  const WIDGET = [ok({ sitekey: SK, secret: "SECRETturnstile" })];

  it("writes <sitekey>:<secret> 0600 from the widget's own GET, masking the secret", () => {
    const r = keys();
    expect(r.code, r.err).toBe(0);
    expect(r.file).toBe(`${SK}:SECRETturnstile\n`);
    expect(statSync(r.path).mode & 0o777).toBe(0o600);
    expect(r.out).toBe("::add-mask::SECRETturnstile\n");
    expect(
      r.sb.log().some((l) => l.endsWith(`/challenges/widgets/${SK}`)),
    ).toBe(true);
  });

  it("pages through the widget list", () => {
    const filler = Array.from({ length: 50 }, (_, i) => ({
      sitekey: `0x4f${i}`,
      name: `w${i}`,
    }));
    const r = keys({
      widgets: [ok(filler), ok(widgets())],
      widget: WIDGET,
    });
    expect(r.code, r.err).toBe(0);
    expect(r.file).toBe(`${SK}:SECRETturnstile\n`);
  });

  it("no widget: no file, exit 0, and no widget GET (provision refuses codes-on by itself)", () => {
    for (const list of [
      [],
      widgets().filter(
        (w) => (w as { name: string }).name !== "oa-p-turnstile",
      ),
    ]) {
      const r = keys({ widgets: [ok(list)], widget: WIDGET });
      expect(r.code, r.err).toBe(0);
      expect(r.file).toBeNull();
      expect(r.out).toMatch(
        /^no Turnstile widget oa-p-turnstile: no keys file/,
      );
      expect(r.sb.log().some((l) => /\/challenges\/widgets\/0x/.test(l))).toBe(
        false,
      );
    }
  });

  it("fails closed: two, a failed listing, a network error, a failed GET or an empty secret", () => {
    const cases: [Record<string, Page[]>, RegExp][] = [
      [
        {
          widgets: [
            ok(widgets(), { total_pages: 2 }),
            ok([{ sitekey: "0x4dup", name: "oa-p-turnstile" }], {
              total_pages: 2,
            }),
          ],
          widget: WIDGET,
        },
        /oa-p-turnstile: 2 found/,
      ],
      [
        { widgets: [JSON.stringify({ success: false })], widget: WIDGET },
        /list Turnstile widgets \(for oa-p-turnstile\) failed/,
      ],
      [
        { widgets: ["NETERR"], widget: WIDGET },
        /oa-p-turnstile.*network error/,
      ],
      [
        {
          widgets: [ok(widgets())],
          widget: [JSON.stringify({ success: false })],
        },
        /read Turnstile widget oa-p-turnstile failed/,
      ],
      [
        { widgets: [ok(widgets())], widget: ["NETERR"] },
        /read Turnstile widget oa-p-turnstile failed: network error/,
      ],
      [
        { widgets: [ok(widgets())], widget: [ok({ sitekey: SK, secret: "" })] },
        /empty secret/,
      ],
      [
        { widgets: [ok(widgets())], widget: [ok({ sitekey: SK })] },
        /empty secret/,
      ],
    ];
    for (const [o, msg] of cases) {
      const r = keys(o);
      expect(r.code, JSON.stringify(o)).toBe(1);
      expect(r.err).toMatch(msg);
      expect(r.file).toBeNull();
    }
  });
});

describe("hosted-r2-key.sh", () => {
  const ID = "0123456789abcdef0123456789abcdef";
  const r2 = (verify: Page[]) => {
    const r = run(["bash", script("hosted-r2-key.sh"), "OUT"], { verify });
    const out = join(r.dir, "OUT");
    return {
      ...r,
      file: existsSync(out) ? readFileSync(out, "utf8") : null,
      path: out,
    };
  };

  it("writes <token id>:<sha256 hex of the token>, 0600, masking both halves first", () => {
    const sha = createHash("sha256").update(TOK).digest("hex");
    const r = r2([ok({ id: ID, status: "active" })]);
    expect(r.code, r.err).toBe(0);
    expect(r.file).toBe(`${ID}:${sha}\n`);
    expect(statSync(r.path).mode & 0o777).toBe(0o600);
    expect(r.out).toBe(`::add-mask::${ID}\n::add-mask::${sha}\n`);
  });

  it("fails closed on a status other than active, an error, a network error or a bad id", () => {
    for (const v of [
      ok({ id: ID, status: "disabled" }),
      ok({ id: ID }),
      ok({ status: "active" }),
      ok({ id: "short", status: "active" }),
      JSON.stringify({ success: false, errors: [{ code: 1000 }] }),
      "NETERR",
    ]) {
      const r = r2([v]);
      expect(r.code, v).toBe(1);
      expect(r.file).toBeNull();
    }
  });

  it("refuses a token with characters that would break the curl config", () => {
    const r = run(
      ["bash", script("hosted-r2-key.sh"), "OUT"],
      {},
      {
        CLOUDFLARE_API_TOKEN: 'abc"\nheader = "X: y',
        TOK_EXPECT: "abc",
      },
    );
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/unexpected characters/);
    expect(r.sb.log().filter((l) => l.startsWith("curl "))).toEqual([]);
  });
});
