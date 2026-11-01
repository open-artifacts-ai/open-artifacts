// cloudflare:workers for the node suites: the base classes the Workflows and
// ProvisionerRpc extend. The workerd suite (test/entry.test.ts) checks the
// real classes' prototypes.
export class WorkerEntrypoint<E = unknown> {
  constructor(
    readonly ctx: unknown,
    readonly env: E,
  ) {}
}
export class WorkflowEntrypoint<E = unknown, _P = unknown> {
  constructor(
    readonly ctx: unknown,
    readonly env: E,
  ) {}
}
