import { type DirectoryBinding, DirectoryBindingSchema } from "@oa/shared";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";

// The directory connection at rest, in P3's directory_state key/value table
// (no migration; T13's DirectorySync reads the same rows):
// - "binding": the DirectoryBinding JSON;
// - "refresh": the sealed refresh token (crypto.ts), never plaintext;
// - "connect.pending": the one connect in flight, {h: sha256(state), u, exp},
//   consumed by its callback (single use);
// - "binding.initial": the initial binding pass, {done, cursor} (T13
//   continues a pass whose cursor is set).

export const K = {
  binding: "binding",
  refresh: "refresh",
  pending: "connect.pending",
  initial: "binding.initial",
} as const;

export const UPSERT = `insert into directory_state (key, value) values (?, ?)
  on conflict (key) do update set value = excluded.value`;

export const putState = (env: Env, key: string, value: string) =>
  stmt(env.DB, UPSERT).bind(key, value);

const READ = "select key, value from directory_state where key in (?, ?)";

/** The binding and the sealed refresh token, in one statement. */
export async function readBinding(
  env: Env,
): Promise<{ binding: DirectoryBinding | null; sealed: string | null }> {
  const { results } = await stmt(env.DB, READ)
    .bind(K.binding, K.refresh)
    .all<{ key: string; value: string }>();
  let binding: DirectoryBinding | null = null;
  let sealed: string | null = null;
  for (const r of results) {
    if (r.key === K.refresh) sealed = r.value;
    else {
      try {
        const p = DirectoryBindingSchema.safeParse(JSON.parse(r.value));
        binding = p.success ? p.data : null;
      } catch {
        binding = null;
      }
    }
  }
  return { binding, sealed };
}

export type InitialPass = { done: boolean; cursor: string | null };

export async function readInitial(env: Env): Promise<InitialPass> {
  const row = await stmt(
    env.DB,
    "select value from directory_state where key = ?",
  )
    .bind(K.initial)
    .first<{ value: string }>();
  try {
    const v = row ? (JSON.parse(row.value) as Partial<InitialPass>) : {};
    return {
      done: v.done === true,
      cursor: typeof v.cursor === "string" ? v.cursor : null,
    };
  } catch {
    return { done: false, cursor: null };
  }
}

export const putInitial = (env: Env, p: InitialPass) =>
  putState(env, K.initial, JSON.stringify(p));
