import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { PROVISIONER_RPC_METHODS } from "@oa/shared/provisioning";
import { describe, expect, it } from "vitest";
import * as entry from "../src/index.js";
import { ManageInstall } from "../src/manage.js";
import { ProvisionerRpc } from "../src/rpc.js";
import {
  CREATE_STEP,
  ProvisionInstall,
  REACHABLE_STEP,
  RELEASE_GATE_STEP,
} from "../src/workflow.js";

// The Worker's surface (design v7 2.1, 2.6): a queue handler and no fetch
// handler, the two Workflow classes, and ProvisionerRpc with exactly three
// methods (Workers RPC exposes every public method, and TS `private` is not
// enforced at runtime).

const JOB = "01JBQ4ZKXW5V9R3M2N8P6T7Y0A";

describe("entrypoint", () => {
  it("exports the default handler, both Workflows and ProvisionerRpc, nothing else", () => {
    expect(Object.keys(entry).sort()).toEqual([
      "ManageInstall",
      "ProvisionInstall",
      "ProvisionerRpc",
      "default",
    ]);
    expect(entry.ProvisionInstall).toBe(ProvisionInstall);
    expect(entry.ManageInstall).toBe(ManageInstall);
    expect(entry.ProvisionerRpc).toBe(ProvisionerRpc);
  });

  it("the default handler has a queue consumer and no fetch handler", () => {
    expect(Object.keys(entry.default)).toEqual(["queue"]);
  });
});

describe("Workflow classes (2.6)", () => {
  // A Worker bound to either class as its entrypoint can call any prototype
  // method, so neither carries a helper.
  for (const [name, W] of [
    ["ProvisionInstall", ProvisionInstall],
    ["ManageInstall", ManageInstall],
  ] as const)
    it(`${name} has exactly constructor and run`, () => {
      expect(Object.getOwnPropertyNames(W.prototype)).toEqual([
        "constructor",
        "run",
      ]);
    });
});

describe("ProvisionerRpc", () => {
  it("has exactly constructor, releases, verifyTurnstile, tokenStatus", () => {
    expect(Object.getOwnPropertyNames(ProvisionerRpc.prototype)).toEqual([
      "constructor",
      "releases",
      "verifyTurnstile",
      "tokenStatus",
    ]);
    expect(["constructor", ...PROVISIONER_RPC_METHODS]).toEqual(
      Object.getOwnPropertyNames(ProvisionerRpc.prototype),
    );
  });

  it("each method delegates to its module function, which W3 builds", async () => {
    const self = { env: {} };
    const p = ProvisionerRpc.prototype;
    for (const call of [
      () => p.releases.call(self),
      () =>
        p.verifyTurnstile.call(self, {
          token: "t",
          remoteIp: "192.0.2.1",
          action: "signup",
          hostname: "signup.open-artifacts-staging.app",
          testUser: false,
        }),
      () => p.tokenStatus.call(self),
    ])
      await expect(call()).rejects.toThrow(/not built yet \(W3\)/);
  });
});

/** A step that records each name and runs nothing. */
const recorder = () => {
  const names: string[] = [];
  const step = {
    do: async (name: string) => {
      names.push(name);
      throw new Error("no step should run");
    },
  } as unknown as WorkflowStep;
  return { names, step };
};
const event = (payload: unknown) =>
  ({
    payload,
    instanceId: JOB,
    timestamp: new Date(0),
  }) as unknown as WorkflowEvent<{ jobId: string }>;

describe("Workflow params (3.6)", () => {
  for (const [name, W] of [
    ["ProvisionInstall", ProvisionInstall],
    ["ManageInstall", ManageInstall],
  ] as const)
    it(`${name}: anything but exactly { jobId: <ULID> } is refused before any step`, async () => {
      for (const bad of [
        {},
        { jobId: JOB.toLowerCase() },
        { jobId: JOB, signupId: JOB },
        { signupId: JOB, slug: "team", ownerSub: "1" },
        null,
      ]) {
        const { names, step } = recorder();
        const e = await W.prototype.run
          .call({ env: {} } as never, event(bad), step)
          .catch((x: unknown) => x);
        expect(e, JSON.stringify(bad)).toBeInstanceOf(NonRetryableError);
        expect((e as Error).message).toBe("internal");
        expect(names).toEqual([]);
      }
    });
});

describe("ProvisionInstall step options (5.2)", () => {
  it("release_gate, create and reachable carry their retries; the rest the defaults", async () => {
    const calls: [string, unknown][] = [];
    const step = {
      do: async (name: string, a: unknown, b?: unknown) => {
        calls.push([name, b === undefined ? undefined : a]);
        return {};
      },
    } as unknown as WorkflowStep;
    await ProvisionInstall.prototype.run.call(
      { env: {} } as never,
      event({ jobId: JOB }),
      step,
    );
    expect(calls).toEqual([
      ["admit", undefined],
      ["recheck", undefined],
      ["reserve", undefined],
      ["release_gate", RELEASE_GATE_STEP],
      ["create", CREATE_STEP],
      ["reachable", REACHABLE_STEP],
      ["notify", undefined],
      ["done", undefined],
    ]);
    expect(RELEASE_GATE_STEP.retries).toMatchObject({
      limit: 3,
      delay: "30 seconds",
      backoff: "exponential",
    });
    expect(REACHABLE_STEP.retries.limit).toBe(2);
  });
});
