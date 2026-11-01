// The release gate and catalog (design v7 5.2 step 4, 5.4, 2.6 releases()):
// signed records per variant, the signed floor, latest installable, and the
// job codes each refusal carries. The release key is the fixtures' (gates
// mocked); the bucket is in memory, read through r2BindingReleaseReader.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  bucketPublishedAt,
  bucketVersions,
  CATALOG_CONCURRENCY,
  releaseCatalog,
  releaseGate,
} from "../src/gate.js";
import { ProvisionRefused } from "../src/jobs.js";
import { FLOOR_KEY, r2BindingReleaseReader } from "../src/publish.js";
import {
  enc,
  floorOf,
  OTHER_SIGNER,
  releaseFixtures,
  signFloor,
  signRecord,
  TEST_PUBKEY,
} from "./fixtures/release.js";
import { MemoryR2, seedRelease } from "./r2-memory.js";

vi.mock("../src/internal/gates.js", async (orig) => ({
  ...(await orig<typeof import("../src/internal/gates.js")>()),
  get RELEASE_PUBKEY() {
    return { staging: TEST_PUBKEY, prod: TEST_PUBKEY };
  },
  FLOOR_MIN_SEQ: { staging: 1, prod: 1 },
}));

const ROOT = new URL("../../../", import.meta.url);
const FIX = releaseFixtures({
  template: new Uint8Array(
    readFileSync(new URL("apps/server/wrangler.template.jsonc", ROOT)),
  ),
  migrations: readdirSync(new URL("apps/server/migrations/", ROOT))
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({
      name,
      bytes: new Uint8Array(
        readFileSync(new URL(`apps/server/migrations/${name}`, ROOT)),
      ),
    })),
});

async function bucket(
  seed: [string, "release" | "redline", number?][],
  o: { floor?: unknown } = {},
) {
  const b = new MemoryR2();
  for (const [v, variant, at] of seed) {
    b.clock = () => at ?? 0;
    await seedRelease(b, FIX.makeRelease(), v, variant);
  }
  if (o.floor !== undefined) await b.put(FLOOR_KEY, JSON.stringify(o.floor));
  return { b, release: r2BindingReleaseReader(b, "staging") };
}

const code = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(ProvisionRefused);
  return (e as ProvisionRefused).code;
};

describe("bucketVersions", () => {
  it("lists the stable versions under releases/, sorted; the floor object is none", async () => {
    const { b } = await bucket([
      ["0.24.0", "release"],
      ["0.23.0", "release"],
      ["0.23.0", "redline"],
    ]);
    await b.put("releases/1.0.0-rc.1/release/record.sig.json", "{}");
    expect(await bucketVersions(b)).toEqual(["0.23.0", "0.24.0"]);
  });
});

describe("releaseGate (5.2 step 4)", () => {
  it("a version given: its variant's record and the floor; redline iff testHooks", async () => {
    const { b, release } = await bucket([
      ["0.23.0", "release"],
      ["0.23.0", "redline"],
    ]);
    const versions = () => bucketVersions(b);
    expect(
      await releaseGate({
        release,
        env: "staging",
        version: "0.23.0",
        testHooks: false,
        versions,
      }),
    ).toEqual({ version: "0.23.0", bundle: "release" });
    expect(
      await releaseGate({
        release,
        env: "staging",
        version: "0.23.0",
        testHooks: true,
        versions,
      }),
    ).toEqual({ version: "0.23.0", bundle: "redline" });
  });

  it("no version: the newest installable with the variant", async () => {
    const { b, release } = await bucket([
      ["0.23.0", "release"],
      ["0.24.0", "redline"],
      ["0.22.0", "release"],
    ]);
    const versions = () => bucketVersions(b);
    expect(
      await releaseGate({
        release,
        env: "staging",
        version: null,
        testHooks: false,
        versions,
      }),
    ).toEqual({ version: "0.23.0", bundle: "release" });
    expect(
      await releaseGate({
        release,
        env: "staging",
        version: null,
        testHooks: true,
        versions,
      }),
    ).toEqual({ version: "0.24.0", bundle: "redline" });
  });

  it("no version skips a revoked or below-floor version", async () => {
    const { b, release } = await bucket(
      [
        ["0.23.0", "release"],
        ["0.24.0", "release"],
        ["0.0.9", "release"],
      ],
      { floor: signFloor(floorOf({ revoked: ["0.24.0"] })) },
    );
    expect(
      await releaseGate({
        release,
        env: "staging",
        version: null,
        testHooks: false,
        versions: () => bucketVersions(b),
      }),
    ).toEqual({ version: "0.23.0", bundle: "release" });
  });

  it("release_not_published: no record of the variant, or nothing installable", async () => {
    const { b, release } = await bucket([["0.23.0", "release"]]);
    const versions = () => bucketVersions(b);
    expect(
      await code(
        releaseGate({
          release,
          env: "staging",
          version: "0.23.0",
          testHooks: true,
          versions,
        }),
      ),
    ).toBe("release_not_published");
    expect(
      await code(
        releaseGate({
          release,
          env: "staging",
          version: "0.30.0",
          testHooks: false,
          versions,
        }),
      ),
    ).toBe("release_not_published");
    expect(
      await code(
        releaseGate({
          release,
          env: "staging",
          version: null,
          testHooks: true,
          versions,
        }),
      ),
    ).toBe("release_not_published");
    expect(
      await code(
        releaseGate({
          release,
          env: "staging",
          version: "1.0.0-rc.1",
          testHooks: false,
          versions,
        }),
      ),
    ).toBe("release_not_published");
  });

  it("release_unverified: another key's signature, a floor refusal, no floor", async () => {
    const { b, release } = await bucket([["0.23.0", "release"]]);
    const versions = () => bucketVersions(b);
    await b.put(
      "releases/0.24.0/release/record.sig.json",
      JSON.stringify(
        signRecord(FIX.recordOf("release", "0.24.0"), OTHER_SIGNER.privateKey),
      ),
    );
    expect(
      await code(
        releaseGate({
          release,
          env: "staging",
          version: "0.24.0",
          testHooks: false,
          versions,
        }),
      ),
    ).toBe("release_unverified");
    // The record is another env's.
    await b.put(
      "releases/0.25.0/release/record.sig.json",
      JSON.stringify(
        signRecord(FIX.recordOf("release", "0.25.0", { env: "prod" })),
      ),
    );
    expect(
      await code(
        releaseGate({
          release,
          env: "staging",
          version: "0.25.0",
          testHooks: false,
          versions,
        }),
      ),
    ).toBe("release_unverified");
    await b.put(
      FLOOR_KEY,
      JSON.stringify(signFloor(floorOf({ revoked: ["0.23.0"] }))),
    );
    expect(
      await code(
        releaseGate({
          release,
          env: "staging",
          version: "0.23.0",
          testHooks: false,
          versions,
        }),
      ),
    ).toBe("release_unverified");
    b.objects.delete(FLOOR_KEY);
    expect(
      await code(
        releaseGate({
          release,
          env: "staging",
          version: "0.23.0",
          testHooks: false,
          versions,
        }),
      ),
    ).toBe("release_unverified");
  });

  it("above: downgrade_refused at or below it", async () => {
    const { b, release } = await bucket([
      ["0.23.0", "release"],
      ["0.24.0", "release"],
    ]);
    const versions = () => bucketVersions(b);
    for (const v of ["0.23.0", "0.22.0"])
      expect(
        await code(
          releaseGate({
            release,
            env: "staging",
            version: v,
            testHooks: false,
            versions,
            above: "0.23.0",
          }),
        ),
      ).toBe("downgrade_refused");
    expect(
      await releaseGate({
        release,
        env: "staging",
        version: "0.24.0",
        testHooks: false,
        versions,
        above: "0.23.0",
      }),
    ).toEqual({ version: "0.24.0", bundle: "release" });
  });
});

describe("releaseCatalog (2.6 releases())", () => {
  it("newest first: verified variants, installable under the floor, one latest, publish times", async () => {
    const { b, release } = await bucket(
      [
        ["0.23.0", "release", 1000],
        ["0.23.0", "redline", 900],
        ["0.24.0", "release", 2000],
        ["0.25.0", "redline", 3000],
        ["0.0.9", "release", 10],
      ],
      { floor: signFloor(floorOf({ revoked: ["0.24.0"] })) },
    );
    await b.put("releases/0.26.0/release/record.sig.json", enc("not json"));
    const cat = await releaseCatalog({
      release,
      env: "staging",
      versions: await bucketVersions(b),
      publishedAt: bucketPublishedAt(b),
    });
    expect(cat).toEqual([
      {
        version: "0.25.0",
        publishedAt: 3000,
        variants: ["redline"],
        installable: true,
        latest: false,
      },
      {
        version: "0.24.0",
        publishedAt: 2000,
        variants: ["release"],
        installable: false,
        latest: false,
      },
      {
        version: "0.23.0",
        publishedAt: 900,
        variants: ["release", "redline"],
        installable: true,
        latest: true,
      },
    ]);
    // 0.0.9 is below the floor's 0.1.0: not listed, and never read.
    expect(b.reads.some((k) => k.includes("0.0.9"))).toBe(false);
  });

  it("reads per call: the floor, then 2 record gets and 2 lists a version (#1029)", async () => {
    const { b, release } = await bucket([
      ["0.23.0", "release"],
      ["0.24.0", "release"],
      ["0.25.0", "release"],
    ]);
    const versions = await bucketVersions(b);
    b.reads.length = 0;
    await releaseCatalog({
      release,
      env: "staging",
      versions,
      publishedAt: bucketPublishedAt(b),
    });
    expect(b.reads.filter((k) => k.startsWith("get ")).length).toBe(1 + 3 * 2);
    expect(b.reads.filter((k) => k.startsWith("list ")).length).toBe(3 * 2);
  });

  it(`at most ${CATALOG_CONCURRENCY} versions are read at once, newest first`, async () => {
    const seed = Array.from(
      { length: 12 },
      (_, i) => [`0.${30 + i}.0`, "release"] as [string, "release"],
    );
    const { b, release } = await bucket(seed);
    b.delayMs = 2;
    const cat = await releaseCatalog({
      release,
      env: "staging",
      versions: await bucketVersions(b),
    });
    expect(b.maxInFlight).toBe(CATALOG_CONCURRENCY);
    expect(cat.map((r) => r.version)).toEqual(seed.map(([v]) => v).reverse());
    expect(cat.filter((r) => r.latest).map((r) => r.version)).toEqual([
      "0.41.0",
    ]);
  });

  it("only: that version alone, read alone; unknown or below the floor is []", async () => {
    const { b, release } = await bucket(
      [
        ["0.0.9", "release"],
        ["0.23.0", "release"],
        ["0.23.0", "redline"],
        ["0.24.0", "release"],
      ],
      { floor: signFloor(floorOf()) },
    );
    const versions = await bucketVersions(b);
    const one = (only: string) =>
      releaseCatalog({
        release,
        env: "staging",
        versions,
        publishedAt: bucketPublishedAt(b),
        only,
      });
    b.reads.length = 0;
    expect(await one("0.23.0")).toEqual([
      {
        version: "0.23.0",
        publishedAt: 0,
        variants: ["release", "redline"],
        installable: true,
        latest: false,
      },
    ]);
    expect(
      b.reads.every((k) => k.includes("0.23.0") || k.includes("floor")),
    ).toBe(true);
    expect(b.reads.filter((k) => k.startsWith("get ")).length).toBe(1 + 2);
    b.reads.length = 0;
    expect(await one("0.0.9")).toEqual([]);
    expect(await one("0.30.0")).toEqual([]);
    expect(
      b.reads.some((k) => k.includes("0.0.9") || k.includes("0.30.0")),
    ).toBe(false);
  });

  it("no floor: nothing is installable", async () => {
    const { b, release } = await bucket([["0.23.0", "release"]]);
    b.objects.delete(FLOOR_KEY);
    const cat = await releaseCatalog({
      release,
      env: "staging",
      versions: await bucketVersions(b),
    });
    expect(cat).toEqual([
      {
        version: "0.23.0",
        publishedAt: null,
        variants: ["release"],
        installable: false,
        latest: false,
      },
    ]);
  });
});
