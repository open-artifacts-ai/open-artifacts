import { type ConsumerEnv, handleSignup } from "./consumer.js";
import type { WorkflowEnv } from "./workflow.js";

export { ProvisionInstall } from "./workflow.js";

export interface Env extends ConsumerEnv, WorkflowEnv {
  HOSTS: KVNamespace;
  BROKER_REGISTRY: KVNamespace;
  DIRECTORY_REGISTRY: KVNamespace;
}

export default {
  // max_batch_size is 1; each message still settles on its own.
  async queue(batch, env) {
    for (const msg of batch.messages) await handleSignup(msg, env);
  },
} satisfies ExportedHandler<Env, unknown>;
