// Pins what the LOCAL Workflow binding (miniflare, workerd) throws for an
// unknown id and a duplicate create, and that the wrapper translates exactly
// those. The real Cloudflare binding is UNVERIFIED (spike S3, staging).
import { env } from "cloudflare:workers";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  createWorkflowInstance,
  getWorkflowInstance,
  isWorkflowExists,
  isWorkflowNotFound,
  WORKFLOW_INSTANCE_STATUSES,
  WorkflowExistsError,
  type WorkflowInstanceStatus,
  type WorkflowLike,
  WorkflowNotFoundError,
} from "../src/provisioning/workflow.js";

const WF = (env as unknown as { WF: Workflow }).WF;
const wf = WF as unknown as WorkflowLike<Record<string, never>>;
const caught = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected a throw");
    },
    (e: unknown) => e as Error & { remote?: unknown },
  );

describe("local Workflow binding (miniflare)", () => {
  it("get(unknown id) throws a plain Error 'instance.not_found'", async () => {
    const e = await caught(WF.get("c6-unknown-0001"));
    expect(e.constructor.name).toBe("Error");
    expect(e.name).toBe("Error");
    expect(e.message).toBe("instance.not_found");
  });

  it("a duplicate create throws a plain Error '(instance.already_exists) ...'", async () => {
    await WF.create({ id: "c6-dup-0001", params: {} });
    const e = await caught(WF.create({ id: "c6-dup-0001", params: {} }));
    expect(e.constructor.name).toBe("Error");
    expect(e.name).toBe("Error");
    expect(e.message).toBe(
      '(instance.already_exists) Workflow instance with id "c6-dup-0001" already exists',
    );
  });

  it("an invalid id is another error", async () => {
    const e = await caught(WF.create({ id: "bad id!", params: {} }));
    expect(e.message).toBe("Workflow instance has invalid id");
  });
});

describe("the wrapper on the local binding", () => {
  it("getWorkflowInstance: unknown id -> WorkflowNotFoundError", async () => {
    const e = await caught(getWorkflowInstance(wf, "c6-unknown-0002"));
    expect(e).toBeInstanceOf(WorkflowNotFoundError);
    expect(isWorkflowNotFound(e)).toBe(true);
  });

  it("createWorkflowInstance: duplicate -> WorkflowExistsError", async () => {
    const first = await createWorkflowInstance(wf, {
      id: "c6-dup-0002",
      params: {},
    });
    expect(first.id).toBe("c6-dup-0002");
    expect((await getWorkflowInstance(wf, "c6-dup-0002")).id).toBe(
      "c6-dup-0002",
    );
    const e = await caught(
      createWorkflowInstance(wf, { id: "c6-dup-0002", params: {} }),
    );
    expect(e).toBeInstanceOf(WorkflowExistsError);
    expect(isWorkflowExists(e)).toBe(true);
  });

  it("an invalid id is rethrown unchanged", async () => {
    const e = await caught(
      createWorkflowInstance(wf, { id: "bad id!", params: {} }),
    );
    expect(e).not.toBeInstanceOf(WorkflowExistsError);
    expect(e).not.toBeInstanceOf(WorkflowNotFoundError);
    expect(e.message).toBe("Workflow instance has invalid id");
  });
});

describe("WorkflowInstanceStatus matches workers-types' InstanceStatus", () => {
  it("has exactly the same status values (rollingBack included)", () => {
    expectTypeOf<WorkflowInstanceStatus["status"]>().toEqualTypeOf<
      InstanceStatus["status"]
    >();
    expectTypeOf<(typeof WORKFLOW_INSTANCE_STATUSES)[number]>().toEqualTypeOf<
      InstanceStatus["status"]
    >();
    expect(WORKFLOW_INSTANCE_STATUSES).toContain("rollingBack");
  });
});
