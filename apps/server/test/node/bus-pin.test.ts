// #2543: the server build verifies the published bus release and pins it.
import { describe, expect, it } from "vitest";
import { ReleaseError } from "../../../../packages/bus-daemon/src/update/errors.ts";
import {
  integrityOf,
  pinVersionFor,
  resolvePin,
} from "../../scripts/bus-pin.ts";
import { busNoPin, cleanWhy } from "../../src/mcp/bus-install.ts";

const PUBLISHED = ["0.150.0", "0.185.0", "0.186.0", "0.186.1", "0.187.0"];
const fakeRel = (v: string) =>
  ({
    version: v,
    tarball: Buffer.alloc(0),
    sha512: "",
    attestations: {},
  }) as never;
const verified = (v: string, hex = "ab".repeat(64)) =>
  ({
    version: v,
    sha512: hex,
    commit: "c",
    entries: [],
    packageJson: {},
  }) as never;

describe("pinVersionFor", () => {
  it("a stable server pins itself", () => {
    expect(pinVersionFor("0.186.0", [])).toBe("0.186.0");
    expect(pinVersionFor("0.186.0+abc1234", [])).toBe("0.186.0");
  });
  it("a pre-release pins the newest stable below it, never itself or a later one", () => {
    expect(pinVersionFor("0.187.0-dev+abc", PUBLISHED)).toBe("0.186.1");
    expect(pinVersionFor("0.186.1-rc.1", PUBLISHED)).toBe("0.186.0");
    expect(pinVersionFor("0.186.0-dev", ["0.186.0"])).toBeNull();
    expect(pinVersionFor("0.1.0-dev", PUBLISHED)).toBeNull();
  });
  it("ignores published names that are not strict x.y.z", () => {
    expect(
      pinVersionFor("1.0.0-dev", ["0.9.0", "0.9.1-rc.1", "latest", "0.10.0 "]),
    ).toBe("0.9.0");
  });
  it("a version that is not a version pins nothing", () => {
    expect(pinVersionFor("latest", PUBLISHED)).toBeNull();
    expect(pinVersionFor("", PUBLISHED)).toBeNull();
  });
});

describe("integrityOf", () => {
  it("is npm's sha512-<base64> of the digest", () => {
    const hex = "00".repeat(63) + "ff";
    expect(integrityOf(hex)).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    expect(integrityOf(hex)).toBe(
      `sha512-${Buffer.from(hex, "hex").toString("base64")}`,
    );
  });
});

describe("resolvePin", () => {
  it("a verified release: its version and integrity, and a log line for reviewers", async () => {
    const r = await resolvePin("0.186.0", {
      fetchRelease: async (v) => fakeRel(v),
      verifyRelease: (rel) => verified(rel.version),
    });
    expect(r.pin).toEqual({
      version: "0.186.0",
      integrity: integrityOf("ab".repeat(64)),
    });
    expect(r.log).toContain("bus pin: @open-artifacts/bus@0.186.0 sha512-");
    expect(r.log).toContain("Sigstore");
  });
  it("a stable server never lists the registry", async () => {
    let listed = false;
    await resolvePin("0.186.0", {
      versions: async () => {
        listed = true;
        return [];
      },
      fetchRelease: async (v) => fakeRel(v),
      verifyRelease: (rel) => verified(rel.version),
    });
    expect(listed).toBe(false);
  });
  it("a pre-release verifies the newest stable below it", async () => {
    const asked: string[] = [];
    const r = await resolvePin("0.187.0-dev+abc", {
      versions: async () => PUBLISHED,
      fetchRelease: async (v) => (asked.push(v), fakeRel(v)),
      verifyRelease: (rel) => verified(rel.version),
    });
    expect(asked).toEqual(["0.186.1"]);
    expect(r.pin?.version).toBe("0.186.1");
  });
  it("every failure is no pin, with the reason, and never throws", async () => {
    const cases: [string, Parameters<typeof resolvePin>[1]][] = [
      [
        "fetch_failed",
        {
          fetchRelease: async () => {
            throw new ReleaseError("fetch_failed", "offline");
          },
        },
      ],
      [
        "no_attestation",
        {
          fetchRelease: async () => {
            throw new ReleaseError("no_attestation", "registry has none");
          },
        },
      ],
      [
        "proof_failed",
        {
          fetchRelease: async (v) => fakeRel(v),
          verifyRelease: () => {
            throw new ReleaseError("proof_failed", "issuer mismatch");
          },
        },
      ],
      [
        "node_too_old",
        {
          fetchRelease: async (v) => fakeRel(v),
          verifyRelease: () => {
            throw new ReleaseError("node_too_old", "needs Node ^22.22.2");
          },
        },
      ],
      [
        "plain error",
        {
          fetchRelease: async () => {
            throw new Error("boom");
          },
        },
      ],
    ];
    for (const [needle, deps] of cases) {
      const r = await resolvePin("0.186.0", deps);
      expect(r.pin, needle).toBeNull();
      expect(r.why, needle).toContain(
        needle === "plain error" ? "boom" : needle,
      );
      expect(r.log).toContain("bus pin: none");
    }
  });
  it("an unlistable registry or no stable below a pre-release: no pin", async () => {
    const down = await resolvePin("0.187.0-dev", {
      versions: async () => {
        throw new Error("registry answered 503");
      },
    });
    expect(down.pin).toBeNull();
    expect(down.why).toContain("could not list");
    const none = await resolvePin("0.1.0-dev", {
      versions: async () => PUBLISHED,
    });
    expect(none.pin).toBeNull();
    expect(none.why).toContain("no published stable release");
  });
});

describe("the no-pin text", () => {
  it("carries the reason as plain text and never an install line", () => {
    const t = busNoPin(
      'proof_failed: issuer mismatch `rm -rf /` "x"\nnext line',
    );
    expect(t).toContain("can't be installed from this build");
    expect(t).toContain("proof_failed: issuer mismatch");
    expect(t).not.toMatch(/`rm|\n|\\"x/);
    expect(t).not.toContain("npm install");
    expect(t).not.toContain("npm pack");
    expect(t).not.toMatch(/install --instance/);
  });
  it("cleanWhy caps and strips", () => {
    expect(cleanWhy("a".repeat(500)).length).toBe(160);
    expect(cleanWhy("x<script>y")).toBe("x script y");
  });
});
