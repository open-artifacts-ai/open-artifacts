// Workflow bindings (ProvisionInstall, ManageInstall): the subset the API and
// the scheduler call (design v7 3.6). Structural, so @oa/shared needs no
// workers-types; no zod, so the scheduler imports
// `@oa/shared/provisioning/workflow`.
import type { WorkflowParams } from "./ids.js";

export type WorkflowInstanceStatus = {
  status:
    | "queued"
    | "running"
    | "paused"
    | "errored"
    | "terminated"
    | "complete"
    | "waiting"
    | "waitingForPause"
    | "unknown";
  error?: { name: string; message: string };
  output?: unknown;
};
export interface WorkflowInstanceLike {
  id: string;
  status(): Promise<WorkflowInstanceStatus>;
  terminate(): Promise<void>;
}

/** WorkflowLike.get: no instance has this id. */
export class WorkflowNotFoundError extends Error {
  override name = "WorkflowNotFoundError";
  constructor(readonly instanceId: string) {
    super(`workflow instance ${instanceId} not found`);
  }
}

/** True only for WorkflowNotFoundError; never matches a message. */
export const isWorkflowNotFound = (e: unknown): e is WorkflowNotFoundError =>
  e instanceof WorkflowNotFoundError;

export interface WorkflowLike<P = WorkflowParams> {
  create(o: { id: string; params: P }): Promise<WorkflowInstanceLike>;
  /**
   * The instance with this id. Throws WorkflowNotFoundError when there is
   * none (the C1 fakes do). UNVERIFIED for the real Cloudflare binding:
   * what `get` does for an unknown id (throw, and with what name or
   * message, or return an instance whose status() fails) is not checked; a
   * wrapper around the real binding must translate it to
   * WorkflowNotFoundError, and must not translate a binding-level error
   * (the Workflow or its script missing). isWorkflowNotFound is an
   * instanceof check, which does not survive an RPC or service-binding
   * boundary (the error arrives as a plain Error), so that wrapper must run
   * in the caller's own isolate, around the binding it calls.
   */
  get(id: string): Promise<WorkflowInstanceLike>;
}
