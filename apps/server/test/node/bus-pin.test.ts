// #2543: the server build verifies the published bus release and pins it.
import { describe, expect, it } from "vitest";
import { ReleaseError } from "../../../../packages/bus-daemon/src/update/errors.ts";
import {
  BUS_PIN_MAX_BACK,
  BUS_PIN_MIN,
  integrityOf,
  pinVersionFor,
  resolvePin,
  resolvePinRequired,
  resolvePinWithFallback,
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

describe("resolvePinRequired (the release run)", () => {
  const opts = (log: string[] = []) => ({
    tries: 10,
    waitMs: 30_000,
    sleep: async () => {},
    log: (l: string) => log.push(l),
  });
  it("registry lag: retries up to 10 times, then succeeds when the release appears", async () => {
    let calls = 0;
    const log: string[] = [];
    const r = await resolvePinRequired(
      "0.186.0",
      {
        fetchRelease: async (v) => {
          if (++calls < 4) throw new ReleaseError("no_attestation", "none yet");
          return fakeRel(v);
        },
        verifyRelease: (rel) => verified(rel.version),
      },
      opts(log),
    );
    expect(calls).toBe(4);
    expect(r.pin?.version).toBe("0.186.0");
    expect(log).toHaveLength(3);
  });
  it("never published: 10 tries, 30 s apart, then no pin", async () => {
    let calls = 0;
    const waits: number[] = [];
    const r = await resolvePinRequired(
      "0.186.0",
      {
        fetchRelease: async () => {
          calls++;
          throw new ReleaseError("fetch_failed", "404");
        },
      },
      {
        ...opts(),
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    );
    expect(r.pin).toBeNull();
    expect(calls).toBe(10);
    expect(waits).toEqual(Array(9).fill(30_000));
  });
  it("a refusal is not lag: no retry", async () => {
    for (const code of [
      "proof_failed",
      "wrong_package",
      "node_too_old",
    ] as const) {
      let calls = 0;
      const r = await resolvePinRequired(
        "0.186.0",
        {
          fetchRelease: async (v) => fakeRel(v),
          verifyRelease: () => {
            calls++;
            throw new ReleaseError(code, "no");
          },
        },
        opts(),
      );
      expect(r.pin, code).toBeNull();
      expect(calls, code).toBe(1);
    }
  });
});

describe("resolvePinWithFallback (the release run, #2543)", () => {
  const PUB = [
    "0.183.0",
    "0.184.0",
    "0.185.0",
    "0.186.0",
    "0.187.0",
    "0.188.0",
  ];
  const o = (min = "0.0.0") => ({
    tries: 2,
    waitMs: 1,
    sleep: async () => {},
    log: () => {},
    min,
  });
  /** Only the versions in `good` verify; the rest are refused. */
  const only = (good: string[], asked: string[] = []) => ({
    versions: async () => PUB,
    fetchRelease: async (v: string) => (asked.push(v), fakeRel(v)),
    verifyRelease: (rel: { version: string }) => {
      if (!good.includes(rel.version))
        throw new ReleaseError("proof_failed", `${rel.version} refused`);
      return verified(rel.version);
    },
  });

  it("its own release verifies: no fallback", async () => {
    const r = await resolvePinWithFallback("0.188.0", only(["0.188.0"]), o());
    expect(r.pin?.version).toBe("0.188.0");
    expect(
      r.pin && "fallbackFor" in r ? r.fallbackFor : undefined,
    ).toBeUndefined();
  });

  it("its own is unverifiable: the newest stable below that verifies, with a warning and the reason", async () => {
    const r = await resolvePinWithFallback(
      "0.188.0",
      only(["0.187.0", "0.186.0"]),
      o(),
    );
    expect(r.pin?.version).toBe("0.187.0");
    expect(r.pin && r.fallbackFor).toBe("0.188.0");
    expect(r.log).toContain(
      "::warning::bus pin fell back to 0.187.0 (own 0.188.0 not verified:",
    );
    expect(r.why).toContain("pinned 0.187.0 as a fallback");
    expect(r.why).toContain("own 0.188.0 not verified");
  });

  it("goes down, newest first, past one that does not verify", async () => {
    const asked: string[] = [];
    const r = await resolvePinWithFallback(
      "0.188.0",
      only(["0.186.0"], asked),
      o(),
    );
    expect(r.pin?.version).toBe("0.186.0");
    expect(asked.slice(-2)).toEqual(["0.187.0", "0.186.0"]);
  });

  it("nothing verifies: no pin, and the reason", async () => {
    const r = await resolvePinWithFallback("0.188.0", only([]), o());
    expect(r.pin).toBeNull();
    expect(r.why).toContain("0.188.0");
    expect(r.why).toContain("verified either");
  });

  it("bound 1: at most 3 stable releases below its own", async () => {
    expect(BUS_PIN_MAX_BACK).toBe(3);
    const asked: string[] = [];
    // Only the fourth below verifies: out of reach.
    const r = await resolvePinWithFallback(
      "0.188.0",
      only(["0.184.0"], asked),
      o(),
    );
    expect(r.pin).toBeNull();
    expect(asked).not.toContain("0.184.0");
    expect(asked.filter((v) => v !== "0.188.0")).toEqual([
      "0.187.0",
      "0.186.0",
      "0.185.0",
    ]);
    // The third below is reachable.
    expect(
      (await resolvePinWithFallback("0.188.0", only(["0.185.0"]), o())).pin
        ?.version,
    ).toBe("0.185.0");
  });

  it("bound 2: never below the minimum kept in the repo", async () => {
    const asked: string[] = [];
    const r = await resolvePinWithFallback(
      "0.188.0",
      only(["0.186.0", "0.185.0"], asked),
      o("0.187.0"),
    );
    expect(r.pin).toBeNull();
    expect(asked).not.toContain("0.186.0");
    expect(
      (await resolvePinWithFallback("0.188.0", only(["0.187.0"]), o("0.187.0")))
        .pin?.version,
    ).toBe("0.187.0");
    expect(BUS_PIN_MIN).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("an unlistable registry: nothing to fall back to", async () => {
    const r = await resolvePinWithFallback(
      "0.188.0",
      {
        ...only([]),
        versions: async () => {
          throw new Error("registry answered 503");
        },
      },
      o(),
    );
    expect(r.pin).toBeNull();
    expect(r.why).toContain("could not list releases to fall back to");
  });

  it("a pre-release falls back below the stable it first pinned", async () => {
    const asked: string[] = [];
    const r = await resolvePinWithFallback(
      "0.189.0-dev+abc",
      only(["0.187.0"], asked),
      o(),
    );
    expect(r.pin?.version).toBe("0.187.0");
    expect(asked.slice(0, 2)).toEqual(["0.188.0", "0.187.0"]);
  });
});
