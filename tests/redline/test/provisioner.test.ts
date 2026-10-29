import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseProvisionerProbe,
  pollUntil,
  provisionerClient,
  ULID_RE,
  ulid,
} from "../src/provisioner.ts";
import { parseManifest } from "../src/report.ts";
import live from "../vitest.live.config.ts";

const root = join(import.meta.dirname, "..");
const OK = {
  accountId: "a".repeat(32),
  platformDbId: "0123abcd-4567-89ef-0123-456789abcdef",
  signupsQueueId: "b".repeat(32),
  tokenFile: "/x/token",
  replaySignupId: "01JBQ7Z8X9Y0ABCDEFGHJKMNPQ",
};
const cfg = (v: unknown) => ({ REDLINE_STG_PROVISIONER: JSON.stringify(v) });

describe("the pending provisioner cases stay out of the gate", () => {
  const pending = readFileSync(
    join(root, "pending/provisioner.test.ts"),
    "utf8",
  );
  const names = [
    "a replayed signup creates nothing new",
    "a signup for a taken slug fails cleanly",
  ];

  it("the live suite does not run pending/, and the manifest lists none of its cases", () => {
    const include = live.test?.include ?? [];
    expect(include).toEqual(["live/**/*.test.ts"]);
    for (const n of names) expect(pending).toContain(`"${n}"`);
    const m = parseManifest(
      readFileSync(join(root, "live/manifest.json"), "utf8"),
    );
    for (const c of m.cases) {
      expect(c.file.startsWith("pending/")).toBe(false);
      for (const n of names) expect(c.name).not.toContain(n);
    }
  });
});

describe("REDLINE_STG_PROVISIONER", () => {
  it("unset is undefined; a valid one parses", () => {
    expect(parseProvisionerProbe({})).toBeUndefined();
    expect(parseProvisionerProbe(cfg(OK))).toEqual(OK);
  });

  it("refuses a malformed field", () => {
    for (const [k, v] of [
      ["accountId", "A".repeat(32)],
      ["platformDbId", "b".repeat(32)],
      ["signupsQueueId", ""],
      ["tokenFile", 1],
      ["replaySignupId", "01jbq7z8x9y0abcdefghjkmnpq"],
      ["replaySignupId", "81JBQ7Z8X9Y0ABCDEFGHJKMNPQ"],
    ] as const)
      expect(() => parseProvisionerProbe(cfg({ ...OK, [k]: v })), k).toThrow(
        new RegExp(k),
      );
    expect(() =>
      parseProvisionerProbe({ REDLINE_STG_PROVISIONER: "{" }),
    ).toThrow(/not JSON/);
  });
});

describe("ulid", () => {
  it("is a ULID whose time prefix sorts with now", () => {
    const a = ulid(1_700_000_000_000);
    const b = ulid(1_700_000_000_001);
    expect(a).toMatch(ULID_RE);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
    expect(ulid(0).slice(0, 10)).toBe("0000000000");
  });
});

describe("the client", () => {
  const TOKEN = "cf-token-secret-value";
  const tokenFile = () => {
    const d = mkdtempSync(join(tmpdir(), "oa-rl-prov-"));
    const f = join(d, "token");
    writeFileSync(f, `${TOKEN}\n`);
    chmodSync(f, 0o600);
    return f;
  };

  it("sends exactly { signupId } to the queue, and D1 one statement with its params", async () => {
    const calls: { url: string; body: unknown; auth: string | null }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        body: JSON.parse(String(init.body)),
        auth: new Headers(init.headers).get("authorization"),
      });
      return Response.json({
        success: true,
        result: [{ results: [{ n: 1 }] }],
      });
    }) as unknown as typeof fetch;
    const c = provisionerClient({ ...OK, tokenFile: tokenFile() }, f);
    await c.enqueue(OK.replaySignupId);
    expect(await c.query("SELECT 1 AS n WHERE ?1", [1])).toEqual([{ n: 1 }]);
    expect(calls).toEqual([
      {
        url: `https://api.cloudflare.com/client/v4/accounts/${OK.accountId}/queues/${OK.signupsQueueId}/messages`,
        body: { body: { signupId: OK.replaySignupId } },
        auth: `Bearer ${TOKEN}`,
      },
      {
        url: `https://api.cloudflare.com/client/v4/accounts/${OK.accountId}/d1/database/${OK.platformDbId}/query`,
        body: { sql: "SELECT 1 AS n WHERE ?1", params: [1] },
        auth: `Bearer ${TOKEN}`,
      },
    ]);
    await expect(c.enqueue("not-a-ulid")).rejects.toThrow(/not a ULID/);
  });

  it("an error names the call and status, never the token or the body", async () => {
    const f = (async () =>
      new Response(`{"errors":[{"message":"${TOKEN}"}]}`, {
        status: 403,
      })) as unknown as typeof fetch;
    const c = provisionerClient({ ...OK, tokenFile: tokenFile() }, f);
    const e = await c.query("SELECT 1").catch((x: Error) => x);
    expect(String(e)).toMatch(/platform D1 query: Cloudflare answered 403/);
    expect(String(e)).not.toContain(TOKEN);
  });
});

describe("pollUntil", () => {
  it("stops when done holds, else at the bound with the last value", async () => {
    let t = 0;
    let n = 0;
    const sleep = async (ms: number) => {
      t += ms;
    };
    const read = async () => ++n;
    expect(
      await pollUntil(
        read,
        (v) => v === 3,
        60_000,
        5_000,
        sleep,
        () => t,
      ),
    ).toEqual({ value: 3, met: true });
    t = 0;
    n = 0;
    expect(
      await pollUntil(
        read,
        () => false,
        20_000,
        5_000,
        sleep,
        () => t,
      ),
    ).toEqual({ value: 5, met: false });
  });
});
