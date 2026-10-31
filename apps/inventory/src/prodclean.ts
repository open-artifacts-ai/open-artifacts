import { GITHUB_OIDC_REF } from "@oa/gh-oidc";
import { ProdcleanReportSchema } from "@oa/shared/provisioning";
import type { Authed } from "./auth.ts";
import { badRequest, type D1Like, forbidden } from "./http.ts";

// POST /prodclean: the hourly monitor's result (design v7 6), stored for the
// scheduler's prodclean_failed alert (@oa/shared alerts.ts). The only D1
// write this Worker makes.

export const MONITOR_WORKFLOW = ".github/workflows/prodclean-monitor.yml";
export const MAX_REPORT_BYTES = 4096;
export const PRODCLEAN_SQL =
  "INSERT INTO prodclean_reports (at, ok, code, install_id, detail) VALUES (?1, ?2, ?3, ?4, ?5)";

// TODO(contract): the five OIDC vars carry no monitor ref, so it is derived
// here and must also be listed in OIDC_JOB_WORKFLOW_REFS.
/** The monitor's job_workflow_ref for a pinned repository. */
export const monitorRef = (repository: string) =>
  `${repository}/${MONITOR_WORKFLOW}@${GITHUB_OIDC_REF}`;

/** The body as text, or null past `max` bytes. */
async function readCapped(req: Request, max: number): Promise<string | null> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (!Number.isFinite(len) || len > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(all);
  } catch {
    return null;
  }
}

export async function postProdclean(
  request: Request,
  auth: Authed,
  db: D1Like,
  now: () => number,
): Promise<Response> {
  const ref = auth.claims.job_workflow_ref;
  if (
    ref !== monitorRef(auth.pins.repository) ||
    !auth.pins.jobWorkflowRefs.includes(ref)
  )
    return forbidden();
  const type = (request.headers.get("content-type") ?? "")
    .split(";")[0]
    ?.trim()
    .toLowerCase();
  if (type !== "application/json") return badRequest();
  const text = await readCapped(request, MAX_REPORT_BYTES);
  if (text === null) return badRequest();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return badRequest();
  }
  const r = ProdcleanReportSchema.safeParse(raw);
  if (!r.success) return badRequest();
  const { ok, code, installId, detail } = r.data;
  await db
    .prepare(PRODCLEAN_SQL)
    .bind(now(), ok ? 1 : 0, code, installId ?? null, detail ?? null)
    .run();
  return new Response(null, {
    status: 204,
    headers: { "cache-control": "no-store" },
  });
}
