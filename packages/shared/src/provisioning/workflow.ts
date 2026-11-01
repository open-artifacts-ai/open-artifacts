// Workflow bindings (ProvisionInstall, ManageInstall): the subset the API and
// the scheduler call (design v7 3.6). Structural, so @oa/shared needs no
// workers-types; no zod, so the scheduler imports
// `@oa/shared/provisioning/workflow`.
import type { WorkflowParams } from "./ids.js";

/** Every Workflow instance status, as workers-types' InstanceStatus (pinned in test-workerd/). */
export const WORKFLOW_INSTANCE_STATUSES = [
  "queued",
  "running",
  "paused",
  "errored",
  "terminated",
  "complete",
  "waiting",
  "waitingForPause",
  "rollingBack",
  "unknown",
] as const;
export type WorkflowStatus = (typeof WORKFLOW_INSTANCE_STATUSES)[number];
/** The statuses an instance never leaves; all others (rollingBack, unknown included) may still change. */
export const WORKFLOW_TERMINAL_STATUSES = [
  "errored",
  "terminated",
  "complete",
] as const satisfies readonly WorkflowStatus[];
export const isTerminalWorkflowStatus = (s: WorkflowStatus): boolean =>
  (WORKFLOW_TERMINAL_STATUSES as readonly WorkflowStatus[]).includes(s);

export type WorkflowInstanceStatus = {
  status: WorkflowStatus;
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

/** WorkflowLike.create: an instance with this id already exists. */
export class WorkflowExistsError extends Error {
  override name = "WorkflowExistsError";
  constructor(readonly instanceId: string) {
    super(`workflow instance ${instanceId} already exists`);
  }
}

/** True only for WorkflowExistsError; never matches a message. */
export const isWorkflowExists = (e: unknown): e is WorkflowExistsError =>
  e instanceof WorkflowExistsError;

// What the binding throws, pinned for the LOCAL binding (miniflare) by
// test-workerd/workflow.test.ts: a plain Error (name "Error") whose message
// is `instance.not_found` (get) or `(instance.already_exists) Workflow
// instance with id "<id>" already exists` (create). The real Cloudflare
// binding (spike S3 on staging, run 41253612244) throws a plain Error with
// `(instance.not_found) Instance not found` and `(instance.already_exists)
// Instance already exists`. The code is matched bare or as a "(code) "
// prefix, nothing looser; c6.test.ts pins both bindings' messages.
const hasCode = (e: unknown, code: string): boolean => {
  if (!(e instanceof Error)) return false;
  const m = e.message;
  return m === code || m === `(${code})` || m.startsWith(`(${code}) `);
};

/**
 * `binding.get(id)`, with the binding's not-found error translated to
 * WorkflowNotFoundError; every other error is rethrown unchanged. Call it in
 * the caller's own isolate, around the binding it holds (the scheduler, W3).
 */
export async function getWorkflowInstance<P>(
  binding: WorkflowLike<P>,
  id: string,
): Promise<WorkflowInstanceLike> {
  try {
    return await binding.get(id);
  } catch (e) {
    if (hasCode(e, "instance.not_found")) throw new WorkflowNotFoundError(id);
    throw e;
  }
}

/**
 * `binding.create(opts)`, with the binding's already-exists error
 * translated to WorkflowExistsError; every other error (an invalid id
 * included) is rethrown unchanged.
 */
export async function createWorkflowInstance<P>(
  binding: WorkflowLike<P>,
  opts: { id: string; params: P },
): Promise<WorkflowInstanceLike> {
  try {
    return await binding.create(opts);
  } catch (e) {
    if (hasCode(e, "instance.already_exists"))
      throw new WorkflowExistsError(opts.id);
    throw e;
  }
}

export interface WorkflowLike<P = WorkflowParams> {
  create(o: { id: string; params: P }): Promise<WorkflowInstanceLike>;
  /**
   * The instance with this id. Throws WorkflowNotFoundError when there is
   * none (the C1 fakes do); around a real binding use getWorkflowInstance,
   * which translates the binding's error (pinned for the local and the real
   * binding: both throw on an unknown id, spike S3). It must not translate a
   * binding-level error (the Workflow or its script missing). isWorkflowNotFound is an
   * instanceof check, which does not survive an RPC or service-binding
   * boundary (the error arrives as a plain Error), so that wrapper must run
   * in the caller's own isolate, around the binding it calls.
   */
  get(id: string): Promise<WorkflowInstanceLike>;
}
