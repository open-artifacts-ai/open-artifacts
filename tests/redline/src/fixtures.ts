import {
  type Cred,
  HttpError,
  newMarker,
  parseJson,
  readBody,
  send,
  withCred,
} from "./http.ts";
import { registerMarker } from "./refused.ts";
import type { Mode, Target } from "./targets.ts";

// Throwaway artifacts and small API helpers for the live cases (P5 Task 5).
// Every throwaway carries a fresh marker in its title and data, so a refusal
// body that leaks any of it fails expectRefused.

/** A request to `t`'s app host with `cred`; JSON body when given. */
export function apiReq(
  t: Target,
  cred: Cred,
  method: string,
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
): Request {
  const headers: Record<string, string> = { "x-oa-request": "1", ...extra };
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(
    `${t.app}${path}`,
    withCred(cred, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

/** Sends and reads the body; throws HttpError (status, body hash) unless 2xx. */
export async function call(
  req: Request,
  what: string,
): Promise<{ res: Response; text: string }> {
  // Bounded: a timeout is a FAIL (an abort error), never a refusal.
  const res = await send(
    new Request(req, { signal: AbortSignal.timeout(15_000) }),
  );
  const text = await readBody(res);
  if (res.status < 200 || res.status > 299)
    throw new HttpError(what, res, text);
  return { res, text };
}

/** The signed-in user behind `cred` at `t`. */
export async function whoami(
  t: Target,
  cred: Cred,
): Promise<{ id: string; email: string }> {
  const { res, text } = await call(
    apiReq(t, cred, "GET", "/api/v1/me"),
    `${t.name} /api/v1/me`,
  );
  const u = (parseJson(res, text, `${t.name} /api/v1/me`) as { user?: unknown })
    .user as { id?: unknown; email?: unknown } | undefined;
  if (typeof u?.id !== "string" || typeof u.email !== "string")
    throw new Error(`${t.name} /api/v1/me: no user`);
  return { id: u.id, email: u.email };
}

export interface Throwaway {
  id: string;
  marker: string;
}

/** Publishes a throwaway html artifact on `t` (title and content carry a marker). */
export async function createThrowaway(
  t: Target,
  pat: Cred,
  o: {
    visibility?: "private" | "public";
    capabilities?: { db?: boolean; storage?: boolean; viewer?: boolean };
    allowAnonymousWrites?: boolean;
  } = {},
): Promise<Throwaway> {
  const marker = newMarker(t);
  registerMarker(t, marker);
  const { res, text } = await call(
    apiReq(t, pat, "POST", "/api/v1/artifacts", {
      title: marker,
      format: "html",
      content: `<!doctype html><title>${marker}</title><p>${marker}</p>`,
      visibility: o.visibility ?? "private",
      ...(o.capabilities ? { capabilities: o.capabilities } : {}),
      ...(o.allowAnonymousWrites !== undefined
        ? { allowAnonymousWrites: o.allowAnonymousWrites }
        : {}),
    }),
    `${t.name} create throwaway`,
  );
  const id = (
    parseJson(res, text, `${t.name} create throwaway`) as {
      id?: unknown;
    }
  ).id;
  if (typeof id !== "string") throw new Error(`${t.name} throwaway: no id`);
  return { id, marker };
}

/** Deletes throwaways; returns how many didn't answer 2xx or 404. */
export async function deleteThrowaways(
  t: Target,
  pat: Cred,
  ids: readonly string[],
): Promise<number> {
  let bad = 0;
  for (const id of ids) {
    const res = await send(
      apiReq(t, pat, "DELETE", `/api/v1/artifacts/${encodeURIComponent(id)}`),
    );
    await readBody(res);
    if (!(res.status >= 200 && res.status < 300) && res.status !== 404) bad++;
  }
  return bad;
}

export const dataPath = (id: string, ...rest: string[]) =>
  [
    `/api/v1/artifacts/${encodeURIComponent(id)}`,
    ...rest.map(encodeURIComponent),
  ]
    .join("/")
    .replace(/\/$/, "");

/**
 * The origin `t`'s server considers its own (appOrigin/contentOrigin): under
 * ENVIRONMENT=dev (local mode) it is http://<host> without the port.
 */
export function serverOrigin(
  t: Target,
  mode: Mode,
  which: "app" | "content",
): string {
  const o = which === "app" ? t.app : t.content;
  return mode === "local" ? `http://${new URL(o).hostname}` : o;
}

/**
 * crossCheck's `send` that snapshots B's state right before the third leg
 * (A's attempt at B), so "unchanged" compares the state A's request met.
 */
export function snapshotBeforeAttack(
  snapshot: () => Promise<string>,
  go: (r: Request) => Promise<Response> = send,
): { send: (r: Request) => Promise<Response>; before: () => string } {
  let n = 0;
  let before: string | null = null;
  return {
    send: async (r) => {
      if (++n === 3) before = await snapshot();
      return go(r);
    },
    before: () => {
      if (before === null) throw new Error("A's attempt at B was never sent");
      return before;
    },
  };
}
