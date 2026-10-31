// Test fakes for ProvisionerRpc and the Workflow bindings (C1). Import from
// "@oa/shared/provisioning/fakes" in tests only.
import { WorkflowParamsSchema } from "./ids.js";
import type {
  ProvisionerRpc,
  TokenStatus,
  VerifyTurnstileInput,
  WorkflowInstanceLike,
  WorkflowInstanceStatus,
  WorkflowLike,
} from "./rpc.js";
import type { Release } from "./schemas.js";

export const FAKE_RELEASES: Release[] = [
  {
    version: "1.42.0",
    publishedAt: 1_790_000_000_000,
    variants: ["release", "redline"],
    installable: true,
    latest: true,
  },
  {
    version: "1.41.2",
    publishedAt: 1_789_000_000_000,
    variants: ["release"],
    installable: true,
    latest: false,
  },
];

export type FakeProvisionerRpc = ProvisionerRpc & {
  calls: { method: keyof ProvisionerRpc; arg?: unknown }[];
};

export function fakeProvisionerRpc(
  o: {
    releases?: Release[];
    tokenStatus?: TokenStatus;
    turnstile?: (i: VerifyTurnstileInput) => boolean;
  } = {},
): FakeProvisionerRpc {
  const calls: FakeProvisionerRpc["calls"] = [];
  return {
    calls,
    async releases() {
      calls.push({ method: "releases" });
      return structuredClone(o.releases ?? FAKE_RELEASES);
    },
    async verifyTurnstile(i) {
      calls.push({ method: "verifyTurnstile", arg: i });
      return { ok: (o.turnstile ?? ((x) => x.token !== ""))(i) };
    },
    async tokenStatus() {
      calls.push({ method: "tokenStatus" });
      return (
        o.tokenStatus ?? {
          status: "active",
          expiresAt: 1_820_000_000_000,
          daysLeft: 340,
        }
      );
    },
  };
}

/** An in-memory Workflow binding: create (params exactly { jobId }), get, status, terminate. */
export class FakeWorkflow implements WorkflowLike {
  readonly created: { id: string; params: unknown }[] = [];
  #status = new Map<string, WorkflowInstanceStatus>();
  #fail: Error | null = null;

  async create(o: { id: string; params: { jobId: string } }) {
    if (this.#fail) {
      const e = this.#fail;
      this.#fail = null;
      throw e;
    }
    const params = WorkflowParamsSchema.parse(o.params);
    if (this.#status.has(o.id))
      throw new Error(`instance ${o.id} already exists`);
    this.created.push({ id: o.id, params });
    this.#status.set(o.id, { status: "queued" });
    return this.#instance(o.id);
  }

  async get(id: string) {
    if (!this.#status.has(id)) throw new Error(`instance ${id} not found`);
    return this.#instance(id);
  }

  /** Test control: move an instance to another status. */
  setStatus(
    id: string,
    status: WorkflowInstanceStatus["status"],
    error?: WorkflowInstanceStatus["error"],
  ) {
    if (!this.#status.has(id)) throw new Error(`instance ${id} not found`);
    this.#status.set(id, { status, ...(error ? { error } : {}) });
  }

  /** Test control: the next create throws `e` (the job stays queued; the sweep starts it). */
  failNextCreate(e: Error) {
    this.#fail = e;
  }

  #instance(id: string): WorkflowInstanceLike {
    return {
      id,
      status: async () =>
        structuredClone(this.#status.get(id) ?? { status: "unknown" }),
      terminate: async () => {
        this.#status.set(id, { status: "terminated" });
      },
    };
  }
}
export * from "./fixtures.js";
