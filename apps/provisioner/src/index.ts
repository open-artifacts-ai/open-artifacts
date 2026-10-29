import { type ConsumerEnv, handleSignup } from "./consumer.js";

export { ProvisionInstall } from "./workflow.js";

export interface Env extends ConsumerEnv {
  HOSTS: KVNamespace;
  BROKER_REGISTRY: KVNamespace;
  DIRECTORY_REGISTRY: KVNamespace;
  RELEASES: R2Bucket;
  WELCOME_EMAIL: SendEmail;
  PROVISION_TOKEN: SecretsStoreSecret;
  WELCOME_FROM: string;
  ACCOUNT_ID: string;
}

export default {
  // max_batch_size is 1; each message still settles on its own.
  async queue(batch, env) {
    for (const msg of batch.messages) await handleSignup(msg, env);
  },
} satisfies ExportedHandler<Env, unknown>;
