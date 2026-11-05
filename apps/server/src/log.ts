/**
 * Server logging. Workers Logs can be read account-wide on hosted installs,
 * so nothing logged may carry a URL, a token, a signed path, an email or a
 * secret. Error text (from fetch, the browser, D1) can embed any of those, so
 * it goes through `redact` before it is logged.
 */

/** Values in `extra` are ids or enums only, never free text. */
export type LogExtra = Record<
  string,
  string | number | boolean | null | undefined
>;

const RULES: [RegExp, string | ((m: string, ...g: string[]) => string)][] = [
  // URLs first, so their paths and query tokens go with them.
  [
    /\b(?:https?|wss?):\/\/([^\s/?#"'<>]+)[^\s"'<>]*/gi,
    (_m, host) => `<url:${host.replace(/^[^@]*@/, "")}>`,
  ],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>"],
  [/\bBearer\s+\S+/gi, "Bearer <token>"],
  // Signed content / page paths: /c/<...> and /p/<...>.
  [/\/[cp]\/[^\s"'<>]+/g, "<path>"],
  // JWT-like (three base64url segments).
  [/\beyJ[\w-]*\.[\w-]+\.[\w-]*/g, "<token>"],
  // Long base64url or hex runs: tokens, signatures, secrets.
  [/[A-Za-z0-9_\-+/]{24,}={0,2}/g, "<token>"],
];

/** The runtime's "internal error; reference = <id>": a support id, not a secret. */
const CF_REFERENCE = /internal error; reference = ([a-z0-9]{8,48})\b/;

export function redact(s: string): string {
  const ref = CF_REFERENCE.exec(s)?.[1];
  let out = s;
  for (const [re, to] of RULES)
    out = out.replace(re, to as (m: string, ...g: string[]) => string);
  return ref
    ? out.replace(
        /internal error; reference = \S+/,
        `internal error; reference = ${ref}`,
      )
    : out;
}

function errParts(err: unknown): { name: string; message: string } {
  if (err instanceof Error)
    return { name: err.name, message: String(err.message) };
  return { name: typeof err, message: String(err) };
}

function emit(
  fn: (s: string) => void,
  evt: string,
  err: unknown,
  extra?: LogExtra,
): void {
  const base: Record<string, unknown> = { evt };
  if (err !== undefined) {
    const { name, message } = errParts(err);
    base.name = name;
    base.message = redact(message).slice(0, 300);
  }
  fn(JSON.stringify({ ...base, ...extra }));
}

export function logError(evt: string, err?: unknown, extra?: LogExtra): void {
  emit(console.error, evt, err, extra);
}

export function logWarn(evt: string, err?: unknown, extra?: LogExtra): void {
  emit(console.warn, evt, err, extra);
}

export function logInfo(evt: string, extra?: LogExtra): void {
  emit(console.log, evt, undefined, extra);
}
