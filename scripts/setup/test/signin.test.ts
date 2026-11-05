import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HELP, run } from "../src/index.ts";
import {
  PROVIDERS,
  resolveSignin,
  SIGNIN,
  SIGNIN_VARS,
  signinProblems,
} from "../src/signin.ts";
import { ROOT, STATE } from "./fakes.ts";
import { HOSTS, world } from "./world.ts";

const CONFIG = join(ROOT, "apps/server/wrangler.jsonc");
type W = ReturnType<typeof world>;
const cfgVars = (w: W) => JSON.parse(w.files.get(CONFIG) ?? "{}").vars ?? {};
const deployedVars = (w: W) => JSON.parse(w.deployed() ?? "{}").vars ?? {};
const line = (w: W, s: string) =>
  w.lines.map((l) => JSON.parse(l)).find((j) => j.step === s);
const GOOGLE = [
  ...["--auth-providers", "access,google,email"],
  ...["--auth-domains", "Example.com, example.org"],
  ...["--auth-domain-join", "member"],
  ...["--google-client-id", "123-abc.apps.googleusercontent.com"],
  ...["--code-emails-per-day", "50"],
];
const LIVE = {
  AUTH_PROVIDERS: "access,google,email",
  AUTH_DOMAINS: "example.com,example.org",
  AUTH_DOMAIN_JOIN: "member",
  GOOGLE_CLIENT_ID: "123-abc.apps.googleusercontent.com",
  CODE_EMAILS_PER_DAY: "50",
};
const empty = Object.fromEntries(SIGNIN_VARS.map((k) => [k, ""])) as Record<
  (typeof SIGNIN_VARS)[number],
  string
>;
/** A world whose Worker was deployed with GOOGLE; then state is dropped (stateless CI). */
async function deployedWithGoogle(o: Parameters<typeof world>[0] = {}) {
  const w = world({ secrets: ["GOOGLE_CLIENT_SECRET"], ...o });
  expect(await run([...HOSTS, ...GOOGLE], w.deps, ROOT)).toBe(0);
  w.files.delete(STATE);
  w.lines.length = 0;
  w.ops.length = 0;
  return w;
}
const deploys = (w: W) =>
  w.ops.filter((o) => o === "deploy" || o.startsWith("migrate"));

describe("setup keeps direct sign-in vars across upgrades", () => {
  it("every SIGNIN flag is a setup option", async () => {
    const src = readFileSync(
      join(import.meta.dirname, "../src/index.ts"),
      "utf8",
    );
    for (const f of Object.values(SIGNIN))
      expect(src, f).toContain(`"${f}": { type: "string" },`);
  });

  it("--help documents the sign-in flags and how to clear them", () => {
    for (const f of [
      "--auth-providers",
      "--auth-domains",
      "--auth-domain-join",
      "--google-client-id",
      "--turnstile-site-key",
      "--email-code-domain",
      "--code-emails-per-day",
    ])
      expect(HELP, f).toContain(f);
    expect(HELP).toMatch(/empty value.*clears/i);
  });

  it("a fresh install with no flags renders none (Access only)", async () => {
    const w = world();
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    for (const k of SIGNIN_VARS)
      expect(deployedVars(w), k).not.toHaveProperty(k);
  });

  it("flags render normalized into the deployed config", async () => {
    const w = await deployedWithGoogle();
    expect(w).toBeDefined();
    expect(deployedVars(w)).toMatchObject(LIVE);
  });

  it("an upgrade with no auth flags keeps the live Worker's sign-in vars", async () => {
    const w = await deployedWithGoogle();
    expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).toBe(0);
    expect(deploys(w)).toContain("deploy");
    expect(deployedVars(w)).toMatchObject(LIVE);
    expect(cfgVars(w)).toMatchObject(LIVE);
    expect(line(w, "deploy").message).toContain("kept the deployed");
  });

  it("an upgrade by name only (no hosts, no state) keeps them too", async () => {
    const w = await deployedWithGoogle();
    expect(
      await run(
        ["--name", "open-artifacts", "--upgrade", "--yes", "--json", "--solo"],
        w.deps,
        ROOT,
      ),
    ).toBe(0);
    expect(deployedVars(w)).toMatchObject(LIVE);
  });

  it("a flag overrides the live value, with a note", async () => {
    const w = await deployedWithGoogle();
    const argv = [...HOSTS, "--upgrade", "--auth-domain-join", "invite"];
    expect(await run(argv, w.deps, ROOT)).toBe(0);
    expect(deployedVars(w)).toMatchObject({
      ...LIVE,
      AUTH_DOMAIN_JOIN: "invite",
    });
    expect(line(w, "deploy").message).toContain(
      "--auth-domain-join invite differs from the deployed AUTH_DOMAIN_JOIN member; using the flag",
    );
  });

  it("--auth-providers access switches back to Access only; an empty value removes a var", async () => {
    const w = await deployedWithGoogle();
    const argv = [
      ...HOSTS,
      "--upgrade",
      ...["--auth-providers", "access"],
      ...["--google-client-id", ""],
      "--auth-domain-join=",
    ];
    expect(await run(argv, w.deps, ROOT)).toBe(0);
    const v = deployedVars(w);
    expect(v.AUTH_PROVIDERS).toBe("access");
    expect(v).not.toHaveProperty("GOOGLE_CLIENT_ID");
    expect(v).not.toHaveProperty("AUTH_DOMAIN_JOIN");
    expect(v.AUTH_DOMAINS).toBe(LIVE.AUTH_DOMAINS);
  });

  it("--check reports the sign-in vars it would deploy", async () => {
    const w = await deployedWithGoogle();
    await run([...HOSTS, "--upgrade", "--check"], w.deps, ROOT);
    expect(line(w, "deploy").data.signin).toEqual(LIVE);
  });

  it("warns when google is on and the Worker has no GOOGLE_CLIENT_SECRET", async () => {
    const w = world();
    expect(await run([...HOSTS, ...GOOGLE], w.deps, ROOT)).toBe(0);
    expect(line(w, "deploy").message).toMatch(
      /warning: .*GOOGLE_CLIENT_SECRET/,
    );
    const ok = world({ secrets: ["GOOGLE_CLIENT_SECRET"] });
    expect(await run([...HOSTS, ...GOOGLE], ok.deps, ROOT)).toBe(0);
    expect(line(ok, "deploy").message).not.toContain("GOOGLE_CLIENT_SECRET");
  });

  it("a fresh install with unreadable settings (no Worker yet) still deploys", async () => {
    const w = world({ settingsFail: true });
    expect(await run([...HOSTS, "--plan", "free"], w.deps, ROOT)).toBe(0);
    expect(deploys(w)).toContain("deploy");
  });

  it("the kept note names each value", async () => {
    const w = await deployedWithGoogle();
    expect(await run([...HOSTS, "--upgrade"], w.deps, ROOT)).toBe(0);
    expect(line(w, "deploy").message).toContain(
      "kept the deployed AUTH_PROVIDERS=access,google,email, AUTH_DOMAINS=example.com,example.org",
    );
  });
});

describe("M2: an existing Worker whose settings can't be read is never deployed", () => {
  const cases: [string, Parameters<typeof world>[0], string[], boolean][] = [
    ["unreadable, full setup, saved state", { settingsFail: true }, [], true],
    [
      "unreadable, --upgrade, saved state",
      { settingsFail: true },
      ["--upgrade"],
      true,
    ],
    ["partial, full setup, saved state", { settingsPartial: true }, [], true],
    [
      "partial, --upgrade, no state",
      { settingsPartial: true },
      ["--upgrade"],
      false,
    ],
  ];
  for (const [name, fail, extra, keepState] of cases)
    it(name, async () => {
      const o: Parameters<typeof world>[0] = {
        secrets: ["GOOGLE_CLIENT_SECRET"],
      };
      const w = world(o);
      expect(await run([...HOSTS, ...GOOGLE], w.deps, ROOT)).toBe(0);
      const before = w.deployed();
      if (!keepState) w.files.delete(STATE);
      Object.assign(o, fail);
      w.ops.length = 0;
      w.lines.length = 0;
      const code = await run(
        [...HOSTS, ...extra, "--plan", "free"],
        w.deps,
        ROOT,
      );
      expect(code).not.toBe(0);
      expect(w.lines.join("\n")).toMatch(
        /setup never deploys an existing Worker without its sign-in vars/,
      );
      expect(deploys(w)).toEqual([]);
      expect(w.deployed()).toBe(before);
    });

  it("install mode, no state, an empty settings read and an existing Worker: refused before any deploy call", async () => {
    const w = world({ settingsPartial: true, workerVersion: "ver-live" });
    expect(await run([...HOSTS, "--plan", "free"], w.deps, ROOT)).toBe(2);
    expect(line(w, "deploy").message).toMatch(
      /refusing to deploy: the live Worker's settings came back with no bindings/,
    );
    expect(deploys(w)).toEqual([]);
    expect(w.deployed()).toBeUndefined();
  });

  it("install mode, no state, an empty settings read and no Worker: a fresh install still deploys", async () => {
    const w = world({ settingsPartial: true });
    expect(await run([...HOSTS, "--plan", "free"], w.deps, ROOT)).toBe(0);
    expect(deploys(w)).toContain("deploy");
  });

  it("the deploy step names the reason", async () => {
    const o: Parameters<typeof world>[0] = {};
    const w = world(o);
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    o.settingsPartial = true;
    w.lines.length = 0;
    expect(await run(HOSTS, w.deps, ROOT)).toBe(2);
    expect(line(w, "deploy").message).toMatch(
      /refusing to deploy: the live Worker's settings came back with no bindings/,
    );
  });
});

describe("M1: live values are carried byte for byte or refused", () => {
  const live = (name: string, text: string) =>
    world({
      secrets: ["GOOGLE_CLIENT_SECRET"],
      workerBindings: [{ type: "plain_text", name, text }],
    });
  for (const [name, text, flag] of [
    ["AUTH_DOMAIN_JOIN", "member ", "--auth-domain-join"],
    ["EMAIL_CODE_DOMAIN", " on", "--email-code-domain"],
    ["AUTH_PROVIDERS", "Google", "--auth-providers"],
    ["AUTH_PROVIDERS", "access,,google", "--auth-providers"],
    ["AUTH_PROVIDERS", "", "--auth-providers"],
    ["AUTH_DOMAINS", "Example.com", "--auth-domains"],
    ["CODE_EMAILS_PER_DAY", "0", "--code-emails-per-day"],
  ] as const)
    it(`refuses a live ${name}=${JSON.stringify(text)} before any deploy call`, async () => {
      const w = live(name, text);
      expect(await run(HOSTS, w.deps, ROOT)).not.toBe(0);
      const m = line(w, "deploy").message;
      expect(m).toContain(`the deployed ${name} ${JSON.stringify(text)}`);
      expect(m).toContain(flag);
      expect(deploys(w)).toEqual([]);
    });

  it("a flag replaces a bad live value", async () => {
    const w = live("AUTH_DOMAIN_JOIN", "member ");
    const argv = [...HOSTS, "--auth-domain-join", "invite"];
    expect(await run(argv, w.deps, ROOT)).toBe(0);
    expect(deployedVars(w).AUTH_DOMAIN_JOIN).toBe("invite");
  });

  it("flags are normalized: trimmed and lowercased", async () => {
    const w = world({ secrets: ["GOOGLE_CLIENT_SECRET"] });
    const argv = [
      ...HOSTS,
      ...["--auth-providers", " Access, GOOGLE "],
      ...["--auth-domains", " Example.COM "],
      ...["--auth-domain-join", "Member"],
      ...["--google-client-id", " x.apps "],
    ];
    expect(await run(argv, w.deps, ROOT)).toBe(0);
    expect(deployedVars(w)).toMatchObject({
      AUTH_PROVIDERS: "access,google",
      AUTH_DOMAINS: "example.com",
      AUTH_DOMAIN_JOIN: "member",
      GOOGLE_CLIENT_ID: "x.apps",
    });
  });

  it("a sign-in var held as a secret or a json binding is refused, naming the flag", async () => {
    for (const type of ["secret_text", "json"]) {
      const w = world({
        secrets: ["GOOGLE_CLIENT_SECRET"],
        workerBindings: [{ type, name: "GOOGLE_CLIENT_ID" }],
      });
      expect(await run(HOSTS, w.deps, ROOT), type).not.toBe(0);
      expect(line(w, "deploy").message, type).toMatch(
        /GOOGLE_CLIENT_ID is a .* on the Worker.*--google-client-id/,
      );
      expect(deploys(w), type).toEqual([]);
    }
  });
});

describe("fail closed before any deploy call", () => {
  const refused = async (argv: string[], re: RegExp) => {
    const w = world({ secrets: ["GOOGLE_CLIENT_SECRET"] });
    const code = await run([...HOSTS, ...argv], w.deps, ROOT);
    expect(code, argv.join(" ")).not.toBe(0);
    const said = w.lines.map((l) => JSON.parse(l).message).join("\n");
    expect(said, argv.join(" ")).toMatch(re);
    expect(deploys(w), argv.join(" ")).toEqual([]);
    expect(w.deployed()).toBeUndefined();
  };

  it("google without GOOGLE_CLIENT_ID", async () => {
    await refused(
      ["--auth-providers", "google", "--auth-domains", "example.com"],
      /GOOGLE_CLIENT_ID is empty/,
    );
  });

  it("an unknown provider", async () => {
    await refused(
      ["--auth-providers", "access,okta"],
      /unknown provider "okta"/,
    );
    await refused(["--auth-providers", ","], /lists no provider/);
  });

  it("AUTH_DOMAIN_JOIN not invite or member", async () => {
    await refused(["--auth-domain-join", "everyone"], /AUTH_DOMAIN_JOIN/);
  });

  it("EMAIL_CODE_DOMAIN not on, CODE_EMAILS_PER_DAY out of range", async () => {
    await refused(["--email-code-domain", "yes"], /EMAIL_CODE_DOMAIN/);
    await refused(["--code-emails-per-day", "10001"], /CODE_EMAILS_PER_DAY/);
  });

  it("google with an empty AUTH_DOMAINS deploys: invited personal accounts only (#864)", async () => {
    const w = world({ secrets: ["GOOGLE_CLIENT_SECRET"] });
    const argv = [
      ...HOSTS,
      ...["--auth-providers", "access,google", "--google-client-id", "x.apps"],
    ];
    expect(await run(argv, w.deps, ROOT)).toBe(0);
    expect(deployedVars(w)).toMatchObject({
      AUTH_PROVIDERS: "access,google",
      GOOGLE_CLIENT_ID: "x.apps",
    });
    expect(deployedVars(w).AUTH_DOMAINS ?? "").toBe("");
  });

  it("a malformed domain", async () => {
    await refused(
      ["--auth-domains", "example.com,not a domain"],
      /invalid domain "not a domain"/,
    );
    await refused(["--auth-domains", "localhost"], /invalid domain/);
  });

  it("a flag that breaks the live combination (google on, client id cleared)", async () => {
    const w = await deployedWithGoogle();
    const before = w.deployed();
    const code = await run(
      [...HOSTS, "--upgrade", "--google-client-id", ""],
      w.deps,
      ROOT,
    );
    expect(code).toBe(1);
    expect(line(w, "deploy").message).toMatch(
      /refusing to deploy: .*GOOGLE_CLIENT_ID is empty/,
    );
    expect(deploys(w)).toEqual([]);
    expect(w.deployed()).toBe(before);
  });

  it("an invalid value on the live Worker is refused, not carried", async () => {
    const w = world({
      workerBindings: [
        { type: "plain_text", name: "AUTH_DOMAIN_JOIN", text: "open" },
      ],
    });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(1);
    expect(line(w, "deploy").message).toMatch(
      /refusing to deploy: the deployed AUTH_DOMAIN_JOIN "open"/,
    );
    expect(deploys(w)).toEqual([]);
  });
});

describe("rules match the server", () => {
  it("PROVIDERS is apps/server/src/auth/config.ts's list", () => {
    const src = readFileSync(
      join(import.meta.dirname, "../../../apps/server/src/auth/config.ts"),
      "utf8",
    );
    const m = src.match(/const PROVIDERS[^=]*=\s*\[([^\]]*)\]/);
    expect(m?.[1]?.match(/"(\w+)"/g)?.map((s) => s.slice(1, -1))).toEqual([
      ...PROVIDERS,
    ]);
  });

  it("CODE_EMAILS_PER_DAY's cap is config.ts CODE_EMAILS_MAX", () => {
    const src = readFileSync(
      join(import.meta.dirname, "../../../apps/server/src/auth/config.ts"),
      "utf8",
    );
    expect(src).toContain("const CODE_EMAILS_MAX = 10_000;");
    expect(signinProblems({ ...empty, CODE_EMAILS_PER_DAY: "10000" })).toEqual(
      [],
    );
  });

  it("signinProblems: unset is fine; google needs a client id, and empty domains is invited personal accounts (#864)", () => {
    expect(signinProblems(empty)).toEqual([]);
    expect(signinProblems({ ...empty, AUTH_PROVIDERS: "google" })).toEqual([
      "google is in AUTH_PROVIDERS but GOOGLE_CLIENT_ID is empty",
    ]);
    expect(
      signinProblems({
        ...empty,
        AUTH_PROVIDERS: "google",
        GOOGLE_CLIENT_ID: "x.apps",
      }),
    ).toEqual([]);
    expect(
      signinProblems({
        ...empty,
        AUTH_PROVIDERS: "google",
        GOOGLE_CLIENT_ID: "x.apps",
        AUTH_DOMAINS: "example.com,not a domain",
      }).join(";"),
    ).toMatch(/invalid domain/);
    expect(signinProblems({ ...empty, ...LIVE })).toEqual([]);
  });

  it("resolveSignin: the flag, then the live value as is", () => {
    const live = [
      { type: "plain_text", name: "AUTH_PROVIDERS", text: "access,email" },
    ];
    const r = resolveSignin({ flags: { AUTH_DOMAINS: "" }, live });
    expect(r.values.AUTH_PROVIDERS).toBe("access,email");
    expect(r.values.AUTH_DOMAINS).toBe("");
    expect(r.kept).toEqual([["AUTH_PROVIDERS", "access,email"]]);
    expect(r.problems).toEqual([]);
  });
});
