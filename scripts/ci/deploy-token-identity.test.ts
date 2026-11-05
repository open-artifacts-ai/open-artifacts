// deploy-token-identity.sh: the deploy token must be active and be the id
// pinned in <env>.json, or the deploy stops before any Cloudflare read or
// write. curl is a stub; the real token must never reach argv or output.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sandbox, script, write } from "./stubs.ts";

const TOKEN = "tok-SECRET.value_123";
const PIN = "983a18d829cffab9ae164d994ceb8dfc";
const OTHER = "11111111111111111111111111111111";

const run = (opts: {
  pin?: string | null;
  http?: number;
  body?: string;
  curlFails?: boolean;
  token?: string;
}) => {
  const sb = sandbox({
    curl: opts.curlFails
      ? "exit 6"
      : `cat >/dev/null <<< "$(cat "$2" 2>/dev/null)"; printf '%s\\n%s' '${opts.body ?? "{}"}' ${opts.http ?? 200}`,
  });
  const hosted = join(sb.dir, "hosted");
  write(
    join(hosted, "prod.json"),
    JSON.stringify(
      opts.pin === null ? {} : { deploy_token_id: opts.pin ?? PIN },
    ),
  );
  const r = sb.run(
    ["bash", script("deploy-token-identity.sh"), "prod", hosted],
    {
      env: { CLOUDFLARE_API_TOKEN: opts.token ?? TOKEN },
    },
  );
  return { ...r, log: sb.log() };
};
const verify = (id: string, status: string) =>
  JSON.stringify({ success: true, result: { id, status } });

describe("deploy-token-identity.sh", () => {
  it("passes for an active token with the pinned id, and prints only id and status", () => {
    const r = run({ body: verify(PIN, "active") });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`id=${PIN} status=active`);
    expect(r.log.filter((l) => l.startsWith("curl "))).toHaveLength(1);
    expect(r.log.join("\n")).toContain("/user/tokens/verify");
  });
  it("fails closed on another token's id, naming both ids", () => {
    const r = run({ body: verify(OTHER, "active") });
    expect(r.code).toBe(1);
    expect(r.err).toContain(OTHER);
    expect(r.err).toContain(PIN);
  });
  it("fails closed on an inactive token", () => {
    const r = run({ body: verify(PIN, "expired") });
    expect(r.code).toBe(1);
    expect(r.err).toContain("not active");
  });
  it("fails closed on an API error, HTTP error or a curl failure", () => {
    expect(
      run({ http: 403, body: '{"success":false,"errors":[{"code":9109}]}' })
        .code,
    ).toBe(1);
    expect(run({ body: "not json" }).code).toBe(1);
    expect(run({ curlFails: true }).code).toBe(1);
    expect(
      run({
        body:
          '{"success":false,"result":{"id":"' + PIN + '","status":"active"}}',
      }).code,
    ).toBe(1);
  });
  it("fails closed on a missing or placeholder pin, before calling Cloudflare", () => {
    for (const pin of [null, "UNSET-printed-by-the-first-spikes-run"]) {
      const r = run({ pin, body: verify(PIN, "active") });
      expect(r.code).toBe(1);
      expect(r.err).toContain("not pinned");
      expect(r.log).toEqual([]);
    }
  });
  it("fails closed on an empty token, before calling Cloudflare", () => {
    const r = run({ token: "", body: verify(PIN, "active") });
    expect(r.code).toBe(1);
    expect(r.log).toEqual([]);
  });
  it("never prints the token or other response fields, and keeps it off argv", () => {
    const r = run({
      body: JSON.stringify({
        success: true,
        result: { id: OTHER, status: "active", expires_on: "LEAKME" },
      }),
    });
    expect(r.out + r.err).not.toContain(TOKEN);
    expect(r.out + r.err).not.toContain("LEAKME");
    expect(r.log.join("\n")).not.toContain(TOKEN);
  });
  it("has one GET curl and no write method", () => {
    const sh = readFileSync(script("deploy-token-identity.sh"), "utf8");
    expect(sh.match(/\bcurl -sS\b/g)).toHaveLength(1);
    expect(sh).not.toMatch(/-X |--data|\b(POST|PUT|PATCH|DELETE)\b/);
  });
});
