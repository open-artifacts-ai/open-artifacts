import {
  addProblem,
  canonicalAddress,
  nameProblem,
  saveInstance,
  suggestName,
} from "@oa/bus-daemon";
import { stripTerminalControls } from "@oa/bus-ipc";
import { type Ctx, say, sayErr } from "../context.ts";
import { LoginFailed, login, RedirectRefused } from "./login.ts";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SHOWN_MAX = 120;
// Control, format and line-separator characters: never shown.
const HIDDEN = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/** What a person sees of an address: no control or colour codes, capped. */
export function showAddress(address: string): string {
  const clean = stripTerminalControls(address).replace(HIDDEN, "");
  return clean.length > SHOWN_MAX ? `${clean.slice(0, SHOWN_MAX)}...` : clean;
}

/**
 * The address as the instance's origin and path, or a reason it is refused.
 * The URL parser turns a non-ASCII host into its xn-- form, so what is shown
 * and what is dialed are the same string.
 */
export function parseAddress(
  raw: string,
): { hub: string; host: string } | { refused: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { refused: "that is not an address" };
  }
  const loopbackHttp = u.protocol === "http:" && LOOPBACK.has(u.hostname);
  if (u.protocol !== "https:" && !loopbackHttp)
    return { refused: "the address must start with https://" };
  if (u.username || u.password)
    return { refused: "the address must not hold a user name or password" };
  if (u.search || u.hash)
    return { refused: "the address must have no query or fragment" };
  const hub = canonicalAddress(u.href);
  if (!hub) return { refused: "that is not an address" };
  return { hub, host: u.host };
}

/**
 * `oa-bus add <address> [--name <name>]`: approves this machine on a second
 * instance and saves its key to instances/<name>.json. machine.json, the
 * main instance, is never written. Terminal only: a person reads the address
 * before the browser opens.
 */
export async function add(
  opts: { address: string; name?: string; noOpen: boolean },
  ctx: Ctx,
): Promise<number> {
  const refuse = (msg: string) => {
    sayErr(ctx, `Not added: ${msg}`);
    return 1;
  };
  if (!ctx.stdinIsTTY || !ctx.stdout.isTTY)
    return refuse(
      "add needs a real terminal; run it yourself, not from a script or an agent.",
    );
  const parsed = parseAddress(opts.address);
  if ("refused" in parsed) return refuse(parsed.refused);
  const name = opts.name ?? suggestName(parsed.hub, ctx.home);
  const bad = nameProblem(name) ?? addProblem(name, parsed.hub, ctx.home);
  if (bad) return refuse(bad);

  say(ctx, `Adding the instance at ${showAddress(parsed.hub)}`);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: tests for non-ASCII
  if (/[^\x00-\x7f]/.test(opts.address))
    say(
      ctx,
      "The address has non-ASCII characters; it is shown in its ASCII (xn--) form.",
    );
  say(ctx, `It will be called ${name} on this machine.`, "");

  try {
    await login({
      hub: parsed.hub,
      home: ctx.home,
      exec: ctx.exec,
      noOpen: opts.noOpen,
      noRedirect: true,
      fetch: ctx.fetch,
      openBrowser: ctx.openBrowser,
      sleep: ctx.sleep,
      now: ctx.now,
      print: ctx.print,
      save: (r) =>
        saveInstance(
          {
            name,
            hub: r.hub,
            machine_id: "",
            label: r.label,
            machine_token: r.machineToken,
          },
          ctx.home,
        ),
    });
  } catch (e) {
    if (e instanceof RedirectRefused || e instanceof LoginFailed)
      return refuse(e.message);
    throw e;
  }
  say(ctx, `Added ${name}.`);
  return 0;
}
