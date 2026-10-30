import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { root, sandbox } from "../ci/stubs.ts";

// hosted-zones.sh: plan reads only and lists each change; apply makes exactly
// those; a different `*` record or route stops both. Tokens reach curl on stdin.
const SCRIPT = join(root, "scripts/ops/hosted-zones.sh");
const ZT = "zone-token-SHOULD-NEVER-APPEAR";
const DT = "deploy-token-SHOULD-NEVER-APPEAR";
const APPZ = "a".repeat(32);
const PAGEZ = "b".repeat(32);

// curl: the zone token for zone calls, the deploy token for Worker checks.
// State: $STATE/wild-<zone>.json, setting-<zone>-<k>.json, routes-<zone>.json,
// workers (names that exist); writes are logged as "WRITE <method> <path> <body>"
// and land in the state, unless $DROP names the kind (dns, setting, route):
// then the API says success and nothing changes.
const curl = `
cfg="$(cat)"
tok=""; case "$cfg" in *"$ZT_EXPECT"*) tok=zone ;; *"$DT_EXPECT"*) tok=deploy ;; esac
m=GET; body=""
for ((i = 1; i <= $#; i++)); do
  [ "\${!i}" = -X ] && { j=$((i + 1)); m="\${!j}"; }
  [ "\${!i}" = -d ] && { j=$((i + 1)); body="\${!j}"; }
done
url="\${@: -1}"; path="\${url#https://api.cloudflare.com/client/v4}"
[ "$m" = GET ] || echo "WRITE $m $path $body" >> "$STUB_LOG"
ok() { printf '{"success":true,"result":%s}' "$1"; }
case "$path" in
  /accounts/*/workers/scripts/*/settings)
    w="\${path#*/workers/scripts/}"; w="\${w%%/*}"
    [ "$tok" = deploy ] && grep -qx "$w" "$STATE/workers" && ok '{}' || echo '{"success":false}' ;;
  /user/tokens/verify) [ "$tok" = zone ] && ok '{"status":"active"}' || echo '{"success":false}' ;;
  "/zones?name="*)
    [ "$tok" = zone ] || { echo '{"success":false}'; exit 0; }
    n="\${path#*name=}"
    case "$n" in *.page) id="$PAGEZ" ;; *) id="$APPZ" ;; esac
    ok "[{\\"id\\":\\"$id\\",\\"name\\":\\"$n\\"}]" ;;
  /zones/*/dns_records\\?name=*)
    z="\${path#/zones/}"; z="\${z%%/*}"; ok "$(cat "$STATE/wild-$z.json" 2>/dev/null || echo '[]')" ;;
  /zones/*/dns_records)
    z="\${path#/zones/}"; z="\${z%%/*}"
    [ "$DROP" = dns ] || echo '[{"type":"AAAA","content":"100::","proxied":true}]' > "$STATE/wild-$z.json"
    ok '{}' ;;
  /zones/*/settings/*)
    z="\${path#/zones/}"; z="\${z%%/*}"; k="\${path##*/}"
    if [ "$m" = PATCH ]; then v="\${body#*:}"; v="\${v%\\}}"
      [ "$DROP" = setting ] || printf '%s' "$v" > "$STATE/setting-$z-$k.json"; ok "{\\"value\\":$v}"
    else ok "{\\"value\\":$(cat "$STATE/setting-$z-$k.json" 2>/dev/null || echo '"off"')}"; fi ;;
  /zones/*/workers/routes)
    z="\${path#/zones/}"; z="\${z%%/*}"
    f="$STATE/routes-$z.json"
    if [ "$m" = POST ]; then
      [ "$DROP" = route ] || { [ -f "$f" ] || echo '[]' > "$f"; jq -c --argjson r "$body" '. + [$r]' "$f" > "$f.new" && mv "$f.new" "$f"; }
      ok '{}'
    else ok "$(cat "$f" 2>/dev/null || echo '[]')"; fi ;;
  *) echo '{"success":false,"errors":[{"message":"unexpected path"}]}' ;;
esac`;

const WILD = '[{"type":"AAAA","content":"100::","proxied":true}]';
const DONE: Record<string, string> = {
  [`wild-${APPZ}.json`]: WILD,
  [`wild-${PAGEZ}.json`]: WILD,
  [`routes-${APPZ}.json`]: JSON.stringify([
    { pattern: "auth.open-artifacts.app/*", script: "oa-p-auth-broker" },
    {
      pattern: "directory.open-artifacts.app/*",
      script: "oa-p-directory-broker",
    },
    { pattern: "*.open-artifacts.app/*", script: "oa-p-dispatch" },
  ]),
  [`routes-${PAGEZ}.json`]: JSON.stringify([
    { pattern: "*.open-artifacts.page/*", script: "oa-p-dispatch" },
  ]),
};
for (const z of [APPZ, PAGEZ]) {
  DONE[`setting-${z}-ssl.json`] = '"strict"';
  DONE[`setting-${z}-always_use_https.json`] = '"on"';
  DONE[`setting-${z}-min_tls_version.json`] = '"1.2"';
}

const setup = (
  files: Record<string, string> = {},
  workers = ["oa-p-dispatch", "oa-p-auth-broker", "oa-p-directory-broker"],
) => {
  const sb = sandbox({ curl });
  const state = join(sb.dir, "state");
  mkdirSync(state);
  writeFileSync(join(state, "workers"), `${workers.join("\n")}\n`);
  for (const [f, v] of Object.entries(files)) writeFileSync(join(state, f), v);
  const summary = join(sb.dir, "summary.md");
  writeFileSync(summary, "");
  const run = (
    mode: string,
    env = "prod",
    extra: Record<string, string> = {},
  ) => {
    const r = sb.run(["bash", SCRIPT, env, mode], {
      env: {
        STATE: state,
        ZONE_TOKEN: ZT,
        ZT_EXPECT: ZT,
        CLOUDFLARE_API_TOKEN: DT,
        DT_EXPECT: DT,
        CLOUDFLARE_ACCOUNT_ID: "26ac346086d4405f7a976d48747a2a75",
        APPZ,
        PAGEZ,
        GITHUB_STEP_SUMMARY: summary,
        DROP: "",
        ...extra,
      },
    });
    const log = sb.log();
    return {
      ...r,
      log,
      writes: log.filter((l) => l.startsWith("WRITE")),
      summary: readFileSync(summary, "utf8"),
    };
  };
  return { run };
};
const clean = (r: {
  out: string;
  err: string;
  log: string[];
  summary: string;
}) => {
  for (const s of [ZT, DT])
    expect([r.out, r.err, r.summary, ...r.log].join("\n")).not.toContain(s);
};

describe("hosted-zones.sh", () => {
  it("plan on fresh zones lists every change, writes nothing, and fills the summary", () => {
    const r = setup().run("plan");
    expect(r.code).toBe(0);
    expect(r.writes).toEqual([]);
    for (const line of [
      "open-artifacts.app: create AAAA * -> 100:: (proxied)",
      'open-artifacts.page: set ssl "off" -> "strict"',
      "route *.open-artifacts.page/* -> oa-p-dispatch: add",
      "route auth.open-artifacts.app/* -> oa-p-auth-broker: add",
      "plan only: nothing changed",
    ]) {
      expect(r.out).toContain(line);
      expect(r.summary).toContain(line);
    }
    clean(r);
  });
  it("apply makes exactly the planned writes: 2 records, 6 settings, 4 routes", () => {
    const r = setup().run("apply");
    expect(r.code).toBe(0);
    expect(r.writes.filter((w) => w.includes("/dns_records "))).toHaveLength(2);
    expect(
      r.writes.filter(
        (w) => w.startsWith("WRITE PATCH") && w.includes("/settings/"),
      ),
    ).toHaveLength(6);
    expect(r.writes.filter((w) => w.includes("/workers/routes "))).toHaveLength(
      4,
    );
    expect(r.writes.join("\n")).toContain(
      '{"type":"AAAA","name":"*","content":"100::","proxied":true}',
    );
    expect(r.out).toContain("applied and read back: matches the expected set");
    expect(r.summary).toContain("applied and read back");
    clean(r);
  });
  it("apply fails when the read-back differs from what the API said it did", () => {
    for (const drop of ["dns", "setting", "route"]) {
      const r = setup().run("apply", "prod", { DROP: drop });
      expect(r.code, drop).toBe(1);
      expect(r.err, drop).toContain("after apply, still not as expected");
      expect(r.out, drop).not.toContain("applied and read back");
    }
  });
  it("refuses a foreign route our patterns match, before any write, in both modes", () => {
    const routes = JSON.parse(DONE[`routes-${APPZ}.json`] as string);
    for (const mode of ["plan", "apply"]) {
      const r = setup({
        [`routes-${APPZ}.json`]: JSON.stringify([
          ...routes,
          { pattern: "x.open-artifacts.app/*", script: "someone-else" },
        ]),
      }).run(mode);
      expect(r.code, mode).toBe(1);
      expect(r.err).toContain(
        "route x.open-artifacts.app/* is not ours but matches *.open-artifacts.app/*",
      );
      expect(r.writes, mode).toEqual([]);
    }
  });
  it("leaves alone a foreign route our patterns don't match", () => {
    const r = setup({
      ...DONE,
      [`routes-${APPZ}.json`]: JSON.stringify([
        ...JSON.parse(DONE[`routes-${APPZ}.json`] as string),
        { pattern: "open-artifacts.app/robots.txt", script: "someone-else" },
      ]),
    }).run("apply");
    expect(r.code, r.err).toBe(0);
    expect(r.writes).toEqual([]);
  });
  it("on wired zones both modes report ok and write nothing", () => {
    for (const mode of ["plan", "apply"]) {
      const r = setup(DONE).run(mode);
      expect(r.code, mode).toBe(0);
      expect(r.writes, mode).toEqual([]);
      expect(r.out).not.toMatch(/: (create|set|add)\b/);
    }
  });
  it("refuses a different * record or a route on another Worker, before writing either", () => {
    for (const [f, v] of [
      [
        `wild-${APPZ}.json`,
        '[{"type":"A","content":"192.0.2.1","proxied":true}]',
      ],
      [
        `routes-${PAGEZ}.json`,
        JSON.stringify([
          { pattern: "*.open-artifacts.page/*", script: "someone-else" },
        ]),
      ],
    ] as const) {
      for (const base of [DONE, {}]) {
        const r = setup({ ...base, [f]: v }).run("apply");
        expect(r.code, f).toBe(1);
        expect(r.writes, f).toEqual([]);
      }
    }
  });
  it("refuses until the target Workers exist, and on a bad env or mode", () => {
    const r = setup({}, ["oa-p-dispatch"]).run("apply");
    expect(r.code).toBe(1);
    expect(r.err).toContain("oa-p-auth-broker does not exist");
    expect(r.writes).toEqual([]);
    expect(setup().run("plan", "dev").code).toBe(2);
    expect(setup().run("destroy").code).toBe(2);
  });
  it("staging uses the staging zones and oa-s Workers", () => {
    const r = setup({}, [
      "oa-s-dispatch",
      "oa-s-auth-broker",
      "oa-s-directory-broker",
    ]).run("plan", "staging");
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "route auth.open-artifacts-staging.app/* -> oa-s-auth-broker: add",
    );
    expect(r.out).toContain(
      "route *.open-artifacts-staging.page/* -> oa-s-dispatch: add",
    );
  });
});
