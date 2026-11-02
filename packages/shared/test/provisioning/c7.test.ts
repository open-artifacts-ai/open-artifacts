// C7 contract fixes: R26 mint job args carry the recipientKey (so the
// Workflow can seal to it), and Workflow's "rollingBack" status (non-terminal,
// as in workers-types' InstanceStatus; pinned against it in test-workerd/).
import { describe, expect, it } from "vitest";
import { FakeWorkflow } from "../../src/provisioning/fakes.js";
import {
  RedlineCredsSchema,
  redlineCredsJobArgs,
} from "../../src/provisioning/schemas.js";
import {
  isTerminalWorkflowStatus,
  WORKFLOW_INSTANCE_STATUSES,
  WORKFLOW_TERMINAL_STATUSES,
} from "../../src/provisioning/workflow.js";

const rid = "req_0123456789abcdef";
const JOB = "01JD7Z9W5Q8X3N4M2K1H0G9F8E";
const key = Buffer.alloc(32, 7).toString("base64url");

describe("redlineCredsJobArgs (R26 jobs.args)", () => {
  const mint = RedlineCredsSchema.parse({ requestId: rid, recipientKey: key });
  const rev = RedlineCredsSchema.parse({ requestId: rid, revoke: true });

  it("a mint is exactly { revoke: false, recipientKey }", () => {
    const a = redlineCredsJobArgs(mint);
    expect(a).toStrictEqual({ revoke: false, recipientKey: key });
    expect(Object.keys(a).sort()).toEqual(["recipientKey", "revoke"]);
  });

  it("a revoke is exactly { revoke: true }", () => {
    const a = redlineCredsJobArgs(rev);
    expect(a).toStrictEqual({ revoke: true });
    expect(Object.keys(a)).toEqual(["revoke"]);
  });

  it("round-trips through RedlineCredsSchema with the row's request_id", () => {
    for (const b of [mint, rev]) {
      // A jobs row stores args as JSON next to request_id.
      const row = {
        request_id: b.requestId,
        args: JSON.stringify(redlineCredsJobArgs(b)),
      };
      const back = RedlineCredsSchema.parse({
        requestId: row.request_id,
        ...JSON.parse(row.args),
      });
      expect(back).toStrictEqual(b);
    }
  });
});

describe("Workflow instance status: rollingBack", () => {
  it("is a status, and not terminal", () => {
    expect(WORKFLOW_INSTANCE_STATUSES).toContain("rollingBack");
    expect(isTerminalWorkflowStatus("rollingBack")).toBe(false);
  });

  it("terminal is exactly errored, terminated, complete", () => {
    expect([...WORKFLOW_TERMINAL_STATUSES].sort()).toEqual([
      "complete",
      "errored",
      "terminated",
    ]);
    const terminal = WORKFLOW_INSTANCE_STATUSES.filter(
      isTerminalWorkflowStatus,
    );
    expect([...terminal].sort()).toEqual(["complete", "errored", "terminated"]);
    for (const s of [
      "queued",
      "running",
      "paused",
      "waiting",
      "waitingForPause",
      "rollingBack",
      "unknown",
    ] as const)
      expect(isTerminalWorkflowStatus(s)).toBe(false);
  });

  it("the fake reports rollingBack, and terminate still ends it", async () => {
    const wf = new FakeWorkflow();
    const i = await wf.create({ id: JOB, params: { jobId: JOB } });
    wf.setStatus(JOB, "rollingBack");
    const s = await i.status();
    expect(s).toEqual({ status: "rollingBack" });
    expect(isTerminalWorkflowStatus(s.status)).toBe(false);
    await i.terminate();
    expect(isTerminalWorkflowStatus((await i.status()).status)).toBe(true);
  });
});
