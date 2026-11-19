import {
  addProblem,
  canonicalAddress,
  nameProblem,
  saveInstance,
  suggestName,
} from "@oa/bus-daemon";
import { stripTerminalControls } from "@oa/bus-ipc";
import { type Ctx, say, sayErr } from "../context.ts";
import { proofIo } from "../steps/adapters.ts";
import { addInstanceProof, readRecord } from "../steps/claude-proof.ts";
import { isDefaultHome } from "../steps/service.ts";
import { LoginFailed, login, RedirectRefused } from "./login.ts";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SHOWN_MAX = 120;
// Control, format and line-separator characters: never shown.
const HIDDEN = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/** What a person sees of an address: no control or colour codes. Never cut. */
export function showAddress(address: string): string {
  return stripTerminalControls(address).replace(HIDDEN, "");
}

class SaveFailed extends Error {}

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
  // The whole address must be readable before the browser opens: never cut it.
  if (showAddress(hub).length > SHOWN_MAX)
    return { refused: "the address is too long to show in full" };
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
      save: (r) => {
        try {
          saveInstance(
            {
              name,
              hub: r.hub,
              machine_id: "",
              label: r.label,
              machine_token: r.machineToken,
            },
            ctx.home,
          );
        } catch (e) {
          throw new SaveFailed((e as Error).message);
        }
      },
    });
  } catch (e) {
    if (e instanceof RedirectRefused || e instanceof LoginFailed)
      return refuse(e.message);
    if (e instanceof SaveFailed)
      return refuse(
        `the hub approved this machine but the key was not saved: ${e.message}`,
      );
    throw e;
  }
  say(ctx, `Added ${name}.`);
  say(
    ctx,
    `The running bus connects to ${name} the next time it restarts (after an update, or when you restart the service). Until then, folders you map to it stay off every hub.`,
    "",
    `Heads up: after that restart, which can be an automatic update, every folder that is not mapped stops going to your main instance and sits on none. To keep your current folders on main, run ${ctx.busCmd} use main in a parent folder such as ~ (it covers everything below it).`,
  );
  claudeEntries(name, parsed.hub, ctx);
  return 0;
}

/**
 * #2793 S4: the Claude Code entries at the new instance's address get a
 * helper that proves this session to that instance only. Never fails the add.
 */
function claudeEntries(name: string, hub: string, ctx: Ctx): void {
  try {
    const io = proofIo({ home: ctx.userHome, busHome: ctx.home, env: ctx.env });
    const r = addInstanceProof(
      {
        // Install's own I/O: writes through a symlinked config, 0600 record.
        ...io,
        // The file install recorded, when there is one.
        file: readRecord(io.record).config ?? io.file,
      },
      { name, hub },
      ctx.service.argv?.() ?? ctx.service.cli(),
      isDefaultHome(ctx.home, ctx.userHome) ? undefined : ctx.home,
    );
    for (const n of r.notes) say(ctx, n);
    if (r.changed.length > 0)
      say(
        ctx,
        `Claude Code: ${r.changed.length === 1 ? "1 entry" : `${r.changed.length} entries`} for ${name} will show as this session on its pages.`,
      );
    else if (r.matched === 0)
      say(
        ctx,
        `Claude Code: to connect it to ${name}, run claude mcp add --transport http open-artifacts-${name} ${showAddress(hub)}/mcp, then ${ctx.busCmd} install.`,
      );
  } catch (e) {
    say(
      ctx,
      `Claude Code: could not set the session helper for ${name}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
