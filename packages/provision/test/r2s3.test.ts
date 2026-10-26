// H-S3: publish writes go through R2's S3 API (SigV4 via aws4fetch, region
// auto), where conditional PutObject is enforced. FakeCf's S3 endpoint
// recomputes each signature with the token's secret and enforces
// If-None-Match / If-Match.
import { readdirSync, readFileSync } from "node:fs";
import { AwsV4Signer } from "aws4fetch";
import { describe, expect, it } from "vitest";
import { CfError, cfClient } from "../src/cf.js";
import { platformNames } from "../src/names.js";
import { probeR2Conditionals } from "../src/publish.js";
import { r2S3Client, r2S3Origin } from "../src/r2s3.js";
import { FakeCf } from "./fake-cf.js";

const enc = (s: string) => new TextEncoder().encode(s);
const fails = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a rejection");
};

function setup() {
  const fake = new FakeCf();
  for (const env of ["staging", "prod"] as const)
    fake.r2.add(platformNames(env).releases);
  const creds = {
    staging: fake.r2Token(platformNames("staging").releases),
    prod: fake.r2Token(platformNames("prod").releases),
  };
  const client = (
    env: "staging" | "prod",
    credentials: { accessKeyId: string; secretAccessKey: string } = creds[env],
  ) =>
    r2S3Client({
      accountId: fake.accountId,
      env,
      credentials,
      fetch: fake.fetch,
      sleep: async () => {},
    });
  return { fake, creds, client };
}

describe("SigV4 through aws4fetch", () => {
  it("matches the AWS SigV4 test suite's get-vanilla vector", async () => {
    // https://docs.aws.amazon.com/IAM/latest/UserGuide/signing-elements.html
    // (aws-sig-v4-test-suite/get-vanilla).
    const s = new AwsV4Signer({
      method: "GET",
      url: "https://example.amazonaws.com/",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      service: "service",
      region: "us-east-1",
      datetime: "20150830T123600Z",
    });
    expect(await s.authHeader()).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  it("aws4fetch is pinned to an exact version", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(pkg.dependencies.aws4fetch).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("signs for s3 in region auto at <account>.r2.cloudflarestorage.com/<bucket>/<key>, the payload hash included", async () => {
    const { fake, client } = setup();
    const seen: Request[] = [];
    const r2 = r2S3Client({
      accountId: fake.accountId,
      env: "staging",
      credentials: fake.r2Token("oa-s-releases"),
      fetch: async (u, i) => {
        seen.push(new Request(u as RequestInfo, i));
        return fake.fetch(u, i);
      },
    });
    await r2.put("releases/0.34.0/release/a+b@c.txt", enc("x"), {
      ifNoneMatch: "*",
    });
    const req = seen[0] as Request;
    expect(req.url).toBe(
      `${r2S3Origin(fake.accountId)}/oa-s-releases/releases/0.34.0/release/a%2Bb%40c.txt`,
    );
    expect(req.headers.get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=[0-9a-f]{32}\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=[^ ]*if-none-match[^ ]*x-amz-content-sha256[^ ]*, Signature=[0-9a-f]{64}$/,
    );
    expect(req.headers.get("x-amz-content-sha256")).toBe(
      "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
    );
    expect(fake.s3SignatureChecks).toBe(1);
    expect(client("staging").bucket).toBe("oa-s-releases");
  });
});

describe("credentials", () => {
  it("a wrong secret is refused by the endpoint; the error carries neither credential half", async () => {
    const { fake, creds, client } = setup();
    const bad = { ...creds.staging, secretAccessKey: "f".repeat(64) };
    const e = await fails(
      client("staging", bad).put("releases/k", enc("x"), { ifNoneMatch: "*" }),
    );
    expect((e as CfError).status).toBe(403);
    expect(e.message).toMatch(/SignatureDoesNotMatch/);
    for (const v of [
      bad.accessKeyId,
      bad.secretAccessKey,
      creds.staging.secretAccessKey,
    ])
      expect(`${e.message} ${e.stack}`).not.toContain(v);
    expect(fake.r2Object("oa-s-releases", "releases/k")).toBeUndefined();
  });

  it("an S3 error body is never copied into the error, only its <Code>", async () => {
    const { creds } = setup();
    const r2 = r2S3Client({
      accountId: "0123456789abcdef0123456789abcdef",
      env: "staging",
      credentials: creds.staging,
      fetch: async () =>
        new Response(
          `<Error><Code>SignatureDoesNotMatch</Code><AWSAccessKeyId>${creds.staging.accessKeyId}</AWSAccessKeyId><StringToSign>${creds.staging.secretAccessKey}</StringToSign></Error>`,
          { status: 403 },
        ),
    });
    const e = await fails(r2.get("releases/k"));
    expect(e.message).toMatch(/HTTP 403 \(SignatureDoesNotMatch\)/);
    expect(e.message).not.toContain(creds.staging.accessKeyId);
    expect(e.message).not.toContain(creds.staging.secretAccessKey);
  });

  it("refuses empty or whitespace credentials before any call", () => {
    const { client, creds } = setup();
    for (const c of [
      { accessKeyId: "", secretAccessKey: "x" },
      { accessKeyId: "a", secretAccessKey: "" },
      { accessKeyId: "a b", secretAccessKey: "x" },
    ])
      expect(() => client("staging", c)).toThrow(/credentials/);
    expect(() => client("staging", creds.staging)).not.toThrow();
  });
});

describe("env isolation", () => {
  it("the bucket is always platformNames(env).releases", () => {
    const { client } = setup();
    expect(client("staging").bucket).toBe(platformNames("staging").releases);
    expect(client("prod").bucket).toBe(platformNames("prod").releases);
    expect(() =>
      r2S3Client({
        accountId: "0".repeat(32),
        env: "dev" as "staging",
        credentials: { accessKeyId: "a", secretAccessKey: "b" },
      }),
    ).toThrow(/env/);
  });

  it("a staging client with the prod token is denied by R2 (scoped to oa-p-releases)", async () => {
    const { fake, creds, client } = setup();
    const r2 = client("staging", creds.prod);
    const e = await fails(probeR2Conditionals(r2, "staging"));
    expect((e as CfError).status).toBe(403);
    expect(e.message).toMatch(/AccessDenied/);
    expect(fake.r2Objects.get("oa-s-releases")?.size ?? 0).toBe(0);
  });

  it("only release and probe keys are reachable; delete takes probe keys only", async () => {
    const { client } = setup();
    const r2 = client("staging");
    for (const k of [
      "k",
      "../oa-p-releases/x",
      "",
      "releases/a b",
      "releases/../../oa-p-releases/x",
      "releases//x",
    ])
      await expect(r2.get(k), k).rejects.toThrow(/release keys/);
    await expect(r2.deleteProbe("releases/floor.json")).rejects.toThrow(
      /probe/,
    );
  });
});

describe("no REST write to oa-*-releases remains", () => {
  it("the Cf client has no R2 put, delete or head for the releases bucket", () => {
    const fake = new FakeCf();
    const cf = cfClient({
      accountId: fake.accountId,
      token: fake.token,
      fetch: fake.fetch,
    });
    for (const m of ["r2ObjectPut", "r2ObjectDelete", "r2ObjectHead"])
      expect(m in cf, m).toBe(false);
  });

  it("no source file sends a non-GET to the REST releases object route", () => {
    const dir = new URL("../src/", import.meta.url);
    const src = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => readFileSync(new URL(f, dir), "utf8"))
      .join("\n");
    expect(src).not.toMatch(/r2ObjectPut|r2ObjectDelete|r2ObjectHead/);
    expect(src).not.toMatch(/call\(\s*"(PUT|POST|DELETE|PATCH)",\s*r2Path/);
  });

  it("a probe, a release publish and a floor publish make no REST PUT or DELETE on oa-*-releases", async () => {
    const { fake, client } = setup();
    const r2 = client("staging");
    await probeR2Conditionals(r2, "staging");
    const rest = fake.log.filter(
      (e) =>
        e.method !== "GET" && /\/r2\/buckets\/oa-[sp]-releases\//.test(e.path),
    );
    expect(rest).toEqual([]);
    expect(fake.r2Log.length).toBeGreaterThan(0);
    expect(fake.r2Log.every((e) => e.api === "s3")).toBe(true);
  });
});

describe("conditionals", () => {
  it("an endpoint that ignores conditionals (2xx twice) makes the probe refuse", async () => {
    const { fake, client } = setup();
    fake.r2IgnoreConditionals = true;
    const e = await fails(probeR2Conditionals(client("staging"), "staging"));
    expect(e.message).toMatch(/ignored If-None-Match: \*/);
    expect(e).not.toBeInstanceOf(CfError);
  });

  it("an endpoint that enforces If-None-Match but not If-Match makes the probe refuse", async () => {
    const { fake, client } = setup();
    const r2 = client("staging");
    const f: typeof fetch = async (u, i) => {
      const h = new Headers(i?.headers);
      if (h.has("if-match")) {
        // Pretend the condition held: store nothing, answer 200.
        return new Response(null, { status: 200, headers: { etag: '"z"' } });
      }
      return fake.fetch(u, i);
    };
    const lax = r2S3Client({
      accountId: fake.accountId,
      env: "staging",
      credentials: fake.r2Token("oa-s-releases"),
      fetch: f,
    });
    const e = await fails(probeR2Conditionals(lax, "staging"));
    expect(e.message).toMatch(/ignored a wrong If-Match/);
    await probeR2Conditionals(r2, "staging");
  });
});
