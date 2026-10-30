// .github/hosted/<env>.json: the committed hosted constants, pinned to their
// sources, and hosted-constants.sh, which loads them into GITHUB_ENV.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { root, sandbox, script } from "./stubs.ts";

const KEYS = [
  "account_id",
  "email_daily_limit",
  "email_zone_tags",
  "google_client_id",
  "google_directory_client_id",
];
const read = (env: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(root, `.github/hosted/${env}.json`), "utf8"));

/** provision's BROKER_GOOGLE_CLIENT_ID[env], through deploy-hosted-platform.sh's own reader. */
const brokerPin = (env: string): string => {
  const sh = readFileSync(
    join(root, "scripts/ops/deploy-hosted-platform.sh"),
    "utf8",
  );
  const m =
    /^broker_pin\(\) \{\n {2}node -e '([\s\S]*?)' "\$BROKER_PIN_FILE" "\$env"\n\}$/m.exec(
      sh,
    );
  if (!m) throw new Error("no broker_pin reader in deploy-hosted-platform.sh");
  const r = spawnSync(
    "node",
    ["-e", m[1] as string, join(root, "packages/provision/src/wfp.ts"), env],
    { encoding: "utf8" },
  );
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
};

describe(".github/hosted/<env>.json", () => {
  it("prod and staging hold exactly the same keys", () => {
    expect(Object.keys(read("prod")).sort()).toEqual(KEYS);
    expect(Object.keys(read("staging")).sort()).toEqual(KEYS);
  });

  it("google_client_id is provision's broker pin, per env", () => {
    for (const env of ["prod", "staging"]) {
      const pin = brokerPin(env);
      expect(pin).toMatch(/\.apps\.googleusercontent\.com$/);
      expect(read(env).google_client_id, env).toBe(pin);
    }
  });

  it("account_id is the hosted account in the docs", () => {
    const docs = readFileSync(join(root, "docs/ops/staging.md"), "utf8");
    const m = /^\| Account \| \| ([0-9a-f]{32}) \|$/m.exec(docs);
    expect(m).not.toBeNull();
    for (const env of ["prod", "staging"])
      expect(read(env).account_id, env).toBe(m?.[1]);
  });

  it("staging's directory client is the directory broker's staging client", () => {
    const w = readFileSync(
      join(root, "apps/directory-broker/wrangler.jsonc"),
      "utf8",
    );
    const m = /"GOOGLE_DIRECTORY_CLIENT_ID": "([^"{]+)"/.exec(w);
    expect(read("staging").google_directory_client_id).toBe(m?.[1]);
  });

  it("prod's email values are the account's", () => {
    expect(read("prod").email_zone_tags).toMatch(/^[0-9a-f]{32}$/);
    expect(read("prod").email_daily_limit).toBe(5000);
  });
});

describe("hosted-constants.sh", () => {
  const load = (
    files: Record<string, unknown> | null,
    env = "prod",
    raw?: string,
  ) => {
    const sb = sandbox({});
    const dir = join(sb.dir, "hosted");
    mkdirSync(dir);
    if (raw !== undefined) writeFileSync(join(dir, `${env}.json`), raw);
    else if (files)
      writeFileSync(join(dir, `${env}.json`), JSON.stringify(files));
    const ghEnv = join(sb.dir, "github-env");
    writeFileSync(ghEnv, "");
    const r = sb.run(["bash", script("hosted-constants.sh"), env, dir], {
      env: { GITHUB_ENV: ghEnv },
    });
    return { ...r, ghEnv: readFileSync(ghEnv, "utf8") };
  };
  const PROD = () => read("prod");

  it("loads every constant into GITHUB_ENV", () => {
    const r = load(PROD());
    expect(r.code, r.err).toBe(0);
    expect(r.ghEnv).toBe(
      [
        "CLOUDFLARE_ACCOUNT_ID=26ac346086d4405f7a976d48747a2a75",
        "EMAIL_ZONE_TAGS=eb90975c0a329d0c743fa4f33f917934",
        "EMAIL_DAILY_LIMIT=5000",
        "GOOGLE_CLIENT_ID=206295999771-ntbp6nlf5ospa45ovc73aur4f05fpp5s.apps.googleusercontent.com",
        "GOOGLE_DIRECTORY_CLIENT_ID=206295999771-6cr3mbfc7g2ejnvdoqhlf2v8v6sdm023.apps.googleusercontent.com",
        "",
      ].join("\n"),
    );
  });

  it("the committed files both load", () => {
    for (const env of ["prod", "staging"]) {
      const sb = sandbox({});
      const ghEnv = join(sb.dir, "github-env");
      writeFileSync(ghEnv, "");
      const r = sb.run(
        [
          "bash",
          script("hosted-constants.sh"),
          env,
          join(root, ".github/hosted"),
        ],
        { env: { GITHUB_ENV: ghEnv } },
      );
      expect(r.code, r.err).toBe(0);
      expect(readFileSync(ghEnv, "utf8").split("\n")).toHaveLength(6);
    }
  });

  it("a missing, null, empty or multi-line value fails and writes nothing", () => {
    for (const k of KEYS) {
      const missing = PROD();
      delete missing[k];
      for (const files of [
        missing,
        { ...PROD(), [k]: null },
        { ...PROD(), [k]: "" },
        { ...PROD(), [k]: "a\nGITHUB_TOKEN=x" },
        { ...PROD(), [k]: ["x"] },
      ]) {
        const r = load(files);
        expect(r.code, `${k} ${JSON.stringify(files[k])}`).toBe(1);
        expect(r.err).toContain(k);
        expect(r.ghEnv).toBe("");
      }
    }
  });

  it("refuses a bad account id, a missing file, bad JSON and a bad env", () => {
    expect(load({ ...PROD(), account_id: "nope" }).code).toBe(1);
    expect(load(null).code).toBe(1);
    expect(load(null, "prod", "{not json").code).toBe(1);
    expect(load(PROD(), "dev").code).toBe(2);
  });
});
