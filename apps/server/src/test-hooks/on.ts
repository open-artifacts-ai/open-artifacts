import { TEST_HOOKS_ALLOWED } from "@oa/shared";
import type { Env } from "../env.js";

// Whether the /__test/* hooks are live (index.ts). Its own module, with no
// imports beyond these, so test-hooks/held.ts can read it without pulling in
// index.ts's routes (an import cycle through directory/connect.ts).

const MIN_KEY = 32;

export type HookEnv = Pick<
  Env,
  "TEST_HOOKS" | "TEST_HOOK_KEY" | "TEST_DOMAIN" | "RL_ANON"
>;

export function testHooksOn(env: HookEnv): boolean {
  return (
    TEST_HOOKS_ALLOWED &&
    env.TEST_HOOKS === "1" &&
    typeof env.TEST_HOOK_KEY === "string" &&
    env.TEST_HOOK_KEY.length >= MIN_KEY &&
    typeof env.TEST_DOMAIN === "string" &&
    env.TEST_DOMAIN.length > 0
  );
}
