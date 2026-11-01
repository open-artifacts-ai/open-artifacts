// .github/hosted/<env>.json: the committed hosted constants, pinned to their
// sources, and hosted-constants.sh, which loads them into GITHUB_ENV.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { root, sandbox, script } from "./stubs.ts";

const KEYS = [
  "account_id",
  "alert_from",
  "alert_to",
  "app_zone",
  "content_zone",
  "deploy_token_id",
  "dispatch_namespace",
  "email_daily_limit",
  "email_zone",
  "google_client_id",
  "google_directory_client_id",
  "signup_daily_cap",
  "signups_enabled",
  "welcome_from",
];
// Read by provapi-spikes.sh and provapi-token-verify.sh only; hosted-constants.sh does not load them.
const SPIKE_KEYS = [
  "app_zone",
  "content_zone",
  "deploy_token_id",
  "dispatch_namespace",
];
const LOADED = KEYS.filter((k) => !SPIKE_KEYS.includes(k));
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

  // Read by provapi-spikes.sh (the staging spikes); pinned to provision's
  // HOSTED_DOMAINS and NAMESPACES so the two never drift.
  it("app_zone, content_zone and dispatch_namespace are provision's, per env", () => {
    const wfp = readFileSync(
      join(root, "packages/provision/src/wfp.ts"),
      "utf8",
    );
    for (const env of ["prod", "staging"]) {
      const d = new RegExp(
        `${env}: Object\\.freeze\\(\\{\\s*app: "([^"]+)",\\s*content: "([^"]+)"`,
      ).exec(wfp);
      expect(d, env).not.toBeNull();
      expect(read(env).app_zone, env).toBe(d?.[1]);
      expect(read(env).content_zone, env).toBe(d?.[2]);
      const ns = new RegExp(
        `NAMESPACES[^=]*= Object\\.freeze\\(\\{[^}]*${env}: "([^"]+)"`,
      ).exec(wfp);
      expect(read(env).dispatch_namespace, env).toBe(ns?.[1]);
    }
    expect(read("staging").dispatch_namespace).toBe("oa-staging");
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

  // The prod Directory client is the one made in project open-artifacts-prod
  // during setup C (2026-10-24); deploy fills it into the broker's
  // {{GOOGLE_DIRECTORY_CLIENT_ID_PROD}}. It is not the staging client.
  it("prod's directory client is the setup C client, distinct from staging's", () => {
    expect(read("prod").google_directory_client_id).toBe(
      "206295999771-6cr3mbfc7g2ejnvdoqhlf2v8v6sdm023.apps.googleusercontent.com",
    );
    expect(read("prod").google_directory_client_id).not.toBe(
      read("staging").google_directory_client_id,
    );
  });

  // Hosted mail is sent as noreply@mail.<app domain> (provision's
  // metadata.ts), so the sending zone is the app zone; its tag is looked up
  // in the run (hosted-resource-ids.sh), never committed.
  it("email_zone is the env's app zone, and no zone tag is committed", () => {
    const wfp = readFileSync(
      join(root, "packages/provision/src/wfp.ts"),
      "utf8",
    );
    for (const env of ["prod", "staging"]) {
      const m = new RegExp(
        `${env}: Object\\.freeze\\(\\{\\s*app: "([^"]+)"`,
      ).exec(wfp);
      expect(m, env).not.toBeNull();
      expect(read(env).email_zone, env).toBe(m?.[1]);
      expect(Object.keys(read(env))).not.toContain("email_zone_tags");
    }
    expect(read("prod").email_daily_limit).toBe(5000);
    expect(read("staging").email_daily_limit).toBe(500);
  });
  // The Manager's values (2026-10-31), filled into the provisioner's and the
  // scheduler's placeholders.
  it("signups stay closed, the caps and alert addresses are the Manager's", () => {
    expect(read("prod").signup_daily_cap).toBe(50);
    expect(read("staging").signup_daily_cap).toBe(20);
    for (const env of ["prod", "staging"]) {
      const c = read(env);
      expect(c.signups_enabled, env).toBe("false");
      expect(c.alert_to, env).toBe("me@leourbina.com");
    }
  });
  // Email Sending only sends from an onboarded domain: mail.<app_zone> (#967),
  // never the apex.
  it("every sender (*_from) is on mail.<app_zone>, the env's onboarded sending domain", () => {
    for (const env of ["prod", "staging"]) {
      const c = read(env);
      const senders = Object.keys(c).filter((k) => k.endsWith("_from"));
      expect(senders.sort(), env).toEqual(["alert_from", "welcome_from"]);
      expect(c.app_zone, env).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
      for (const k of senders) {
        const v = String(c[k]);
        expect(
          v.endsWith(`@mail.${String(c.app_zone)}`),
          `${env} ${k}: ${v}`,
        ).toBe(true);
        expect(v.split("@")[0], `${env} ${k}`).toMatch(/^[a-z0-9._-]+$/);
      }
    }
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
        "ALERT_FROM=alerts@mail.open-artifacts.app",
        "ALERT_TO=me@leourbina.com",
        "EMAIL_ZONE=open-artifacts.app",
        "EMAIL_DAILY_LIMIT=5000",
        "GOOGLE_CLIENT_ID=206295999771-ntbp6nlf5ospa45ovc73aur4f05fpp5s.apps.googleusercontent.com",
        "GOOGLE_DIRECTORY_CLIENT_ID=206295999771-6cr3mbfc7g2ejnvdoqhlf2v8v6sdm023.apps.googleusercontent.com",
        "SIGNUP_DAILY_CAP=50",
        "SIGNUPS_ENABLED=false",
        "WELCOME_FROM=welcome@mail.open-artifacts.app",
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
      const lines = readFileSync(ghEnv, "utf8").split("\n");
      expect(lines).toHaveLength(LOADED.length + 1);
    }
  });

  it("a missing, null, empty or multi-line value fails and writes nothing", () => {
    for (const k of LOADED) {
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

  it("refuses a placeholder or malformed value in any key, before writing anything", () => {
    const bad: [string, unknown][] = [
      ["account_id", "UNCONFIRMED-account"],
      ["account_id", "A".repeat(32)],
      ["email_zone", "UNCONFIRMED-set-the-sending-zone"],
      ["email_zone", "{{EMAIL_ZONE_PROD}}"],
      ["email_zone", "open-artifacts.app/x"],
      ["email_daily_limit", "UNCONFIRMED"],
      ["email_daily_limit", 0],
      ["email_daily_limit", "5000;x"],
      ["email_daily_limit", 1234567890],
      ["google_client_id", "{{GOOGLE_CLIENT_ID_PROD}}"],
      ["google_client_id", "UNCONFIRMED.apps.googleusercontent.com"],
      ["google_directory_client_id", "TODO"],
      ["google_directory_client_id", "1-x.apps.googleusercontent.com.evil"],
      ["signup_daily_cap", 0],
      ["signup_daily_cap", 10000],
      ["signup_daily_cap", "20 "],
      ["signups_enabled", "test-users"],
      ["signups_enabled", "TRUE"],
      ["signups_enabled", "true"],
      ["welcome_from", "welcome"],
      ["welcome_from", "W <a@b.com>"],
      ["welcome_from", "a@b.com/x"],
    ];
    for (const [k, v] of bad) {
      const r = load({ ...PROD(), [k]: v });
      expect(r.code, `${k}=${v}`).toBe(1);
      expect(r.err).toContain(`${k} is not a valid value`);
      expect(r.ghEnv, `${k}=${v}`).toBe("");
    }
  });

  it("alert_to is required and checked like any other address", () => {
    for (const v of ["ops", "A <a@b.com>", "a@b.com,c@d.com", "a@b.com/x"]) {
      const bad = load({ ...PROD(), alert_to: v });
      expect(bad.code, JSON.stringify(v)).toBe(1);
      expect(bad.err).toContain("alert_to is not a valid value");
      expect(bad.ghEnv).toBe("");
    }
  });

  it("SIGNUPS_ENABLED test-users loads for staging only", () => {
    const st = load(
      { ...read("staging"), signups_enabled: "test-users" },
      "staging",
    );
    expect(st.code, st.err).toBe(0);
    expect(st.ghEnv).toContain("SIGNUPS_ENABLED=test-users\n");
    expect(
      load({ ...read("staging"), signups_enabled: "true" }, "staging").code,
    ).toBe(1);
    expect(
      load({ ...read("staging"), signups_enabled: "TEST-USERS" }, "staging")
        .code,
    ).toBe(1);
  });

  it("refuses a bad account id, a missing file, bad JSON and a bad env", () => {
    expect(load({ ...PROD(), account_id: "nope" }).code).toBe(1);
    expect(load(null).code).toBe(1);
    expect(load(null, "prod", "{not json").code).toBe(1);
    expect(load(PROD(), "dev").code).toBe(2);
  });
});
