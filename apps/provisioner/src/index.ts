import { type ConsumerEnv, handleSignup } from "./consumer.js";
import type { ManageEnv } from "./manage.js";
import type { RpcEnv } from "./rpc.js";
import type { WorkflowEnv } from "./workflow.js";

export { ManageInstall } from "./manage.js";
export { ProvisionerRpc } from "./rpc.js";
export { ProvisionInstall } from "./workflow.js";

export interface Env extends ConsumerEnv, WorkflowEnv, ManageEnv, RpcEnv {}

// No fetch handler (design v7 2.1): the Worker has no routes.
export default {
  // max_batch_size is 1; each message still settles on its own.
  async queue(batch, env) {
    for (const msg of batch.messages) await handleSignup(msg, env);
  },
} satisfies ExportedHandler<Env, unknown>;
