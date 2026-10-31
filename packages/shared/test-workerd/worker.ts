// A Workflow that does nothing: the test only needs a real binding.
import { WorkflowEntrypoint } from "cloudflare:workers";

export class TestWorkflow extends WorkflowEntrypoint {
  override async run(): Promise<string> {
    return "ok";
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  },
};
