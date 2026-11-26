import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Deps, Exec } from "../src/cf.ts";

export const ROOT = "/repo";
export const STATE = join(ROOT, ".openartifacts/state.json");
export const FLAGS = [
  ...["--name", "open-artifacts"],
  ...["--app-host", "app.example.com", "--content-host", "c.example.com"],
  ...["--owner-email", "o@example.com", "--yes", "--json"],
];

/** Cloudflare v4 envelope, as recorded from api.cloudflare.com. */
export const envelope = (
  result: unknown,
  status = 200,
  errors: unknown[] = [],
) =>
  new Response(JSON.stringify({ success: status < 400, errors, result }), {
    status,
  });

type Core = {
  answers?: string[];
  env?: Record<string, string>;
  files?: Record<string, string>;
  /** Mode per path; a file without one is 0600. */
  modes?: Record<string, number>;
  exec?: Exec;
  stdout?: string;
  fetch?: typeof fetch;
};

/** In-memory fs, captured output, scripted prompts; no network, no processes. */
export function core(o: Core = {}) {
  const files = new Map(Object.entries(o.files ?? {}));
  const lines: string[] = [];
  /** Settles when the first line is printed: the signal a test waits on. */
  let firstPrinted: () => void = () => {};
  const printed = new Promise<void>((r) => {
    firstPrinted = r;
  });
  const prompts: string[] = [];
  const answers = [...(o.answers ?? [])];
  const sleeps: number[] = [];
  let clock = 0;
  let tempCount = 0;
  /** Paths written through writeSecret (0600 files). */
  const secretWrites: string[] = [];
  const deps: Deps = {
    env: o.env ?? {},
    fs: {
      read: (p) => files.get(p) ?? null,
      write: (p, d) => void files.set(p, d),
      hashTree: (base, rels, include) => {
        const hit = [...files.keys()]
          .filter((k) => include?.(k.slice(base.length + 1)) ?? true)
          .filter((k) =>
            rels.some((r) => {
              const p = r === "." ? base : `${base}/${r}`;
              return k === p || k.startsWith(`${p}/`);
            }),
          )
          .sort();
        return hit.length
          ? createHash("sha256")
              .update(
                hit
                  .map((k) => `${k.slice(base.length)}\0${files.get(k)}`)
                  .join("\0"),
              )
              .digest("hex")
          : undefined;
      },
      tempDir: () => `/tmp/oa-bundle-${++tempCount}`,
      removeTree: (p) => {
        for (const k of [...files.keys()])
          if (k === p || k.startsWith(`${p}/`)) files.delete(k);
      },
      writeSecret: (p, d) => {
        files.set(p, d);
        secretWrites.push(p);
      },
      readToken: (p) =>
        files.has(p)
          ? {
              text: files.get(p) as string,
              mode: o.modes?.[p] ?? 0o600,
              uid: process.getuid?.() ?? 0,
              isFile: true,
            }
          : null,
    },
    out: (l) => {
      lines.push(l);
      firstPrinted();
    },
    prompt: async (q, opts) => {
      prompts.push(opts?.secret ? `[secret] ${q}` : q);
      return answers.shift() ?? "";
    },
    exec:
      o.exec ?? (async () => ({ code: 0, stdout: o.stdout ?? "", stderr: "" })),
    fetch: o.fetch ?? (async () => envelope(null, 500)),
    // The fake clock advances only by sleeping, so waits are deterministic.
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  };
  const state = () => JSON.parse(files.get(STATE) ?? "{}");
  return { deps, files, lines, printed, prompts, state, sleeps, secretWrites };
}
