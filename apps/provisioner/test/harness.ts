import type { FakeCf } from "../../../packages/provision/test/fake-cf.js";
import type { Welcome } from "../src/welcome.js";

/** What the workflow suite hands its Worker (same isolate, so shared). */
export const H = {
  fake: null as FakeCf | null,
  clock: { t: 0 },
  mail: [] as Welcome[],
  /** Sends to fail before one goes through. */
  failSends: 0,
  /** Each step body's run: its output or its error. */
  steps: [] as {
    id: string;
    name: string;
    output?: unknown;
    error?: { name: string; message: string };
  }[],
  /** Vars over the test config's. */
  vars: {} as Record<string, string>,
  cf(): FakeCf {
    if (!H.fake) throw new Error("no fake-cf for this test");
    return H.fake;
  },
};
