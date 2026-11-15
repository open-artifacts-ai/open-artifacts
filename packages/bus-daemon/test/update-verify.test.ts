import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { MIN_COMMIT_VERSION, PINS, type Pins } from "../src/update/pins.ts";
import { EMBEDDED_ROOT, type RootJson } from "../src/update/trusted-root.ts";
import { checkManifest, verifyRelease } from "../src/update/verify.ts";
import { GOLDEN_NOW, golden, makeTgz } from "./update-helpers.ts";

const opts = { now: GOLDEN_NOW };
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code ?? "other";
  }
  return "none";
};
const pins = (over: Partial<Pins>): Pins => ({ ...(PINS as Pins), ...over });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("verifyRelease (offline)", () => {
  it("accepts the real 0.186.0 release and returns its bytes' entries", () => {
    const v = verifyRelease(golden(), opts);
    expect(v.version).toBe("0.186.0");
    expect(v.commit).toBe("3b62435bce64bc43457a20b9a079fb727d088676");
    expect(v.packageJson.name).toBe("@open-artifacts/bus");
    expect(v.entries.some((e) => e.path === "package/dist/index.js")).toBe(
      true,
    );
  });

  it.each([
    ["wrong repo id", { repoId: "1" }],
    ["wrong owner id", { ownerId: "2" }],
    ["wrong workflow", { workflowPath: ".github/workflows/other.yml" }],
    ["wrong ref", { ref: "refs/tags/v0.186.0" }],
    ["wrong issuer", { oidcIssuer: "https://accounts.example.com" }],
    ["wrong repo url", { repoUrl: "https://github.com/someone/else" }],
    ["wrong runner", { runnerEnvironment: "self-hosted" }],
    ["wrong trigger", { trigger: "workflow_dispatch" }],
    ["wrong builder", { builderId: "https://example.com/builder" }],
  ] as [string, Partial<Pins>][])("refuses %s", (_n, over) => {
    expect(
      code(() => verifyRelease(golden(), { ...opts, pins: pins(over) })),
    ).toBe("proof_failed");
  });

  it("refuses a tarball changed by one byte", () => {
    const g = golden();
    const t = Buffer.from(g.tarball);
    t[t.length - 20] = (t[t.length - 20] as number) ^ 1;
    // fetch's streamed digest follows the bytes it saw
    const sha512 = createHash("sha512").update(t).digest("hex");
    expect(code(() => verifyRelease({ ...g, tarball: t, sha512 }, opts))).toBe(
      "proof_failed",
    );
  });

  it("refuses when the streamed digest disagrees with the bytes", () => {
    expect(
      code(() => verifyRelease({ ...golden(), sha512: "00".repeat(64) }, opts)),
    ).toBe("proof_failed");
  });

  it("refuses a different version than the one signed", () => {
    expect(
      code(() => verifyRelease({ ...golden(), version: "0.186.1" }, opts)),
    ).toBe("proof_failed");
  });

  it.each([
    "1.2",
    "1.2.3-x",
    "01.2.3",
    "1.2.3 ",
    "١.٢.٣",
    "v1.2.3",
    "1.2.3.4",
    "",
  ])("refuses version %j", (v) => {
    expect(code(() => verifyRelease({ ...golden(), version: v }, opts))).toBe(
      "bad_version",
    );
  });

  it("refuses a missing or empty attestation", () => {
    expect(
      code(() => verifyRelease({ ...golden(), attestations: {} }, opts)),
    ).toBe("no_attestation");
    expect(
      code(() =>
        verifyRelease(
          { ...golden(), attestations: { attestations: [] } },
          opts,
        ),
      ),
    ).toBe("no_attestation");
    expect(
      code(() => verifyRelease({ ...golden(), attestations: null }, opts)),
    ).toBe("no_attestation");
  });

  it("refuses with only the npm publish attestation (key-signed, no certificate)", () => {
    const g = golden();
    const a = clone(g.attestations) as {
      attestations: { predicateType: string }[];
    };
    a.attestations = a.attestations.filter(
      (x) => !x.predicateType.includes("slsa"),
    );
    expect(code(() => verifyRelease({ ...g, attestations: a }, opts))).toBe(
      "no_attestation",
    );
  });

  it("refuses a bundle with no transparency log entry", () => {
    const g = golden();
    const a = clone(g.attestations) as {
      attestations: { predicateType: string; bundle: any }[];
    };
    const b = a.attestations.find((x) => x.predicateType.includes("slsa"))!;
    b.bundle.verificationMaterial.tlogEntries = [];
    expect(code(() => verifyRelease({ ...g, attestations: a }, opts))).toBe(
      "proof_failed",
    );
  });

  it("refuses a tampered statement (signature no longer verifies)", () => {
    const g = golden();
    const a = clone(g.attestations) as {
      attestations: { predicateType: string; bundle: any }[];
    };
    const b = a.attestations.find((x) => x.predicateType.includes("slsa"))!;
    const st = JSON.parse(
      Buffer.from(b.bundle.dsseEnvelope.payload, "base64").toString(),
    );
    st.subject[0].digest.sha512 = "00".repeat(64);
    b.bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(st)).toString(
      "base64",
    );
    expect(code(() => verifyRelease({ ...g, attestations: a }, opts))).toBe(
      "proof_failed",
    );
  });

  it("refuses when the chain is untrusted (no Fulcio root in the root file)", () => {
    const root = clone(EMBEDDED_ROOT) as RootJson & {
      certificateAuthorities: unknown[];
    };
    // keep the old, expired CA only: this cert was not issued by it
    root.certificateAuthorities = root.certificateAuthorities.slice(0, 1);
    const c = code(() => verifyRelease(golden(), { ...opts, root }));
    expect(["proof_failed", "stale_trust_root"]).toContain(c);
  });

  it("fails closed with a distinct reason when the embedded roots are stale", () => {
    expect(
      code(() =>
        verifyRelease(golden(), { now: new Date("2040-01-01T00:00:00Z") }),
      ),
    ).toBe("stale_trust_root");
  });

  it("fails with the stale reason when the log is not in the embedded root", () => {
    const root = clone(EMBEDDED_ROOT) as RootJson & {
      tlogs: { publicKey: { validFor: { end?: string } } }[];
    };
    const g = golden();
    const a = clone(g.attestations) as {
      attestations: { predicateType: string; bundle: any }[];
    };
    const b = a.attestations.find((x) => x.predicateType.includes("slsa"))!;
    b.bundle.verificationMaterial.tlogEntries[0].logId.keyId = Buffer.alloc(
      32,
      7,
    ).toString("base64");
    expect(
      code(() => verifyRelease({ ...g, attestations: a }, { ...opts, root })),
    ).toBe("stale_trust_root");
  });

  describe("package.json inside the verified bytes", () => {
    // Re-sign is impossible, so these swap the verified-bytes check by
    // unit-testing the wrong_package gate through a signed tarball whose
    // package.json we cannot change: use a different expected name via pins.
    it("refuses a package of another name", () => {
      const c = code(() =>
        verifyRelease(golden(), {
          ...opts,
          pins: pins({ packageName: "@someone/else" }),
        }),
      );
      expect(c).toBe("wrong_package");
    });
  });

  it("does not read any pin from the environment", () => {
    process.env.OA_BUS_REGISTRY = "https://evil.example";
    process.env.OA_BUS_REPO_ID = "1";
    try {
      expect(verifyRelease(golden(), opts).version).toBe("0.186.0");
    } finally {
      delete process.env.OA_BUS_REGISTRY;
      delete process.env.OA_BUS_REPO_ID;
    }
  });

  it("unrelated tar garbage under a valid signature cannot be reached", () => {
    // A tarball that is not the signed one fails on the digest first.
    const bad = makeTgz([{ name: "package/package.json", data: "{}" }]);
    const sha512 = createHash("sha512").update(bad).digest("hex");
    expect(
      code(() => verifyRelease({ ...golden(), tarball: bad, sha512 }, opts)),
    ).toBe("proof_failed");
    expect(gzipSync(Buffer.alloc(0)).length).toBeGreaterThan(0);
  });
});

describe("checkManifest", () => {
  const P = PINS as Pins;
  const commit = "a".repeat(40);
  const base = { name: "@open-artifacts/bus", version: "1.2.3" };
  const c = (pkg: object, v = "1.2.3") =>
    code(() => checkManifest(pkg as never, P, v, commit));
  it("accepts name and version alone for today's releases", () => {
    expect(c(base)).toBe("none");
  });
  it("accepts a matching oaBus commit", () => {
    expect(c({ ...base, oaBus: { commit } })).toBe("none");
  });
  it("ignores a tag field, right or wrong", () => {
    expect(c({ ...base, oaBus: { tag: "v9.9.9", commit } })).toBe("none");
    expect(c({ ...base, oaBus: { tag: "v9.9.9" } })).toBe("none");
  });
  it("refuses a wrong name, version or commit, or a malformed commit", () => {
    expect(c({ ...base, name: "x" })).toBe("wrong_package");
    expect(c({ ...base, version: "1.2.4" })).toBe("wrong_package");
    expect(c({ ...base, oaBus: { commit: "b".repeat(40) } })).toBe(
      "wrong_package",
    );
    expect(c({ ...base, oaBus: { commit: "A".repeat(40) } })).toBe(
      "wrong_package",
    );
    expect(c({ ...base, oaBus: { commit: 5 } })).toBe("wrong_package");
  });
  it("requires the commit from MIN_COMMIT_VERSION on", () => {
    const v = MIN_COMMIT_VERSION;
    const ok = { name: base.name, version: v };
    expect(c(ok, v)).toBe("wrong_package");
    expect(c({ ...ok, oaBus: { tag: `v${v}` } }, v)).toBe("wrong_package");
    expect(c({ ...ok, oaBus: { commit: "b".repeat(40) } }, v)).toBe(
      "wrong_package",
    );
    expect(c({ ...ok, oaBus: { commit } }, v)).toBe("none");
  });
});
