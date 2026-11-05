import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * The step shape from openartifacts/scripts/setup/src/step.ts: every step
 * has a read-only check() (what `install --check` runs) and an apply().
 */
export type Step<C> = {
  name: string;
  /** The line `install --check` prints when the check passes. */
  label: string;
  /** The `×` line when it fails, and the next action under it. */
  failed: string;
  action: string;
  check: (ctx: C) => Promise<"done" | "todo">;
  /** Prints its own lines; false stops the run (it printed its failure). */
  apply: (ctx: C) => Promise<boolean>;
};

export type StepRecord = { status: "ok" | "failed"; at: string };

/**
 * `<OA_BUS_HOME>/install.json` is shared with the adapters step, which
 * keeps its `created` containers there: every write keeps the other keys.
 */
export function readInstallFile(path: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof v === "object" && v !== null && !Array.isArray(v))
      return v as Record<string, unknown>;
  } catch {}
  return {};
}

export function updateInstallFile(
  path: string,
  patch: Record<string, unknown>,
): void {
  const next = { ...readInstallFile(path), ...patch };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Runs the steps in order, recording each; stops at the first failure. */
export async function runSteps<C>(
  steps: Step<C>[],
  ctx: C,
  record: { path: string; now: () => number },
): Promise<boolean> {
  for (const step of steps) {
    let ok = false;
    try {
      ok = await step.apply(ctx);
    } finally {
      const steps = readInstallFile(record.path).steps;
      updateInstallFile(record.path, {
        steps: {
          ...(typeof steps === "object" && steps !== null ? steps : {}),
          [step.name]: {
            status: ok ? "ok" : "failed",
            at: new Date(record.now()).toISOString(),
          } satisfies StepRecord,
        },
      });
    }
    if (!ok) return false;
  }
  return true;
}

/** Every step's check(), in order; writes nothing. */
export async function checkSteps<C>(
  steps: Step<C>[],
  ctx: C,
): Promise<{ step: Step<C>; state: "done" | "todo" }[]> {
  const out: { step: Step<C>; state: "done" | "todo" }[] = [];
  for (const step of steps) out.push({ step, state: await step.check(ctx) });
  return out;
}
