import { WorkflowEntrypoint } from "cloudflare:workers";
import type { ProvisionParams } from "./message.js";

/** Placeholder: Task 6 replaces it with reserve, sweep+create, notify, done. */
export class ProvisionInstall extends WorkflowEntrypoint<
  unknown,
  ProvisionParams
> {
  async run(): Promise<void> {
    throw new Error("ProvisionInstall is not implemented yet");
  }
}
