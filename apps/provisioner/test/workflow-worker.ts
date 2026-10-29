// The workflow suite's main Worker: ProvisionInstall on fake-cf. It runs in
// the tests' isolate, so it reads the fake, clock and mailbox each test sets
// in `H` (test/harness.ts).
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { ProvisionParams } from "../src/message.js";
import { ProvisionInstall, type WorkflowEnv } from "../src/workflow.js";
import { H } from "./harness.js";

type TestEnv = WorkflowEnv & { WF_PLATFORM_DB: D1Database };

export class TestProvisionInstall extends ProvisionInstall {
  constructor(ctx: ExecutionContext, env: TestEnv) {
    super(ctx, {
      ...env,
      PLATFORM_DB: env.WF_PLATFORM_DB,
      WELCOME_EMAIL: {
        send: async (m: unknown) => {
          if (H.failSends > 0) {
            H.failSends--;
            throw new Error("send failed");
          }
          H.mail.push(m as (typeof H.mail)[number]);
          return { messageId: `m${H.mail.length}` };
        },
      } as unknown as SendEmail,
      PROVISION_TOKEN: {
        get: async () => H.cf().token,
      } as SecretsStoreSecret,
      ...H.vars,
    });
    this.fetch = (input, init) => H.cf().fetch(input, init);
    this.now = () => H.clock.t;
    this.sleep = async (ms) => {
      H.clock.t += ms;
    };
  }

  // Every step body's result and thrown error, as the engine stores them.
  override run(
    event: Readonly<WorkflowEvent<ProvisionParams>>,
    step: WorkflowStep,
  ): Promise<void> {
    const spy = {
      do: (name: string, ...rest: unknown[]) => {
        const body = rest.pop() as () => Promise<unknown>;
        return (step.do as (...a: unknown[]) => Promise<unknown>)(
          name,
          ...rest,
          async () => {
            try {
              const out = await body();
              H.steps.push({ id: event.instanceId, name, output: out });
              return out;
            } catch (e) {
              H.steps.push({
                id: event.instanceId,
                name,
                error: {
                  name: (e as Error).name,
                  message: (e as Error).message,
                },
              });
              throw e;
            }
          },
        );
      },
    } as unknown as WorkflowStep;
    return super.run(event, spy);
  }
}

export default {
  fetch: () => new Response(null, { status: 404 }),
} satisfies ExportedHandler;
