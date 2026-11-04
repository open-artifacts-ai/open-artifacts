import { execFile } from "node:child_process";
import {
  deliveredText,
  messageHeader,
  stripTerminalControls,
} from "@oa/bus-ipc";
import type { AgentRecord } from "../agents.ts";
import type { DeliverOutcome, Mail } from "../deliver.ts";

/**
 * Runs a command to completion. `code` is null when the process did not exit
 * on its own (killed at its timeout); rejects when it could not start.
 */
export type Spawn = (
  cmd: string,
  args: string[],
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/** Errors that mean the command never started. */
const START_ERRORS = new Set(["ENOENT", "EACCES"]);

/** The production Spawn: `execFile` with a kill timeout. */
export const execSpawn =
  (timeoutMs: number, maxBuffer = 1024 * 1024): Spawn =>
  (cmd, args) =>
    new Promise((resolve, reject) => {
      execFile(
        cmd,
        args,
        { timeout: timeoutMs, maxBuffer },
        (err, stdout, stderr) => {
          if (!err) return resolve({ code: 0, stdout, stderr });
          const e = err as NodeJS.ErrnoException & {
            code?: number | string;
            killed?: boolean;
          };
          if (typeof e.code === "string" && START_ERRORS.has(e.code))
            return reject(err);
          resolve({
            code: e.killed || typeof e.code !== "number" ? null : e.code,
            stdout,
            stderr,
          });
        },
      );
    });

/** A Spawn as an exec: a kill at the timeout is a failed exit. */
export const spawnExec =
  (spawn: Spawn) =>
  async (
    cmd: string,
    args: string[],
  ): Promise<{ code: number; stdout: string; stderr: string }> => {
    const r = await spawn(cmd, args);
    return { ...r, code: r.code ?? -1 };
  };

export type OpenCodeTransportOptions = {
  /** Root session ids a live TUI has open, read fresh on every call. */
  openSessions: () => Set<string>;
  spawn: Spawn;
  log?: (msg: string) => void;
  /**
   * False below MIN_PROMPT_ID_VERSION: OpenCode may admit a repeated id twice,
   * so a timed-out prompt is never sent again. Default true.
   */
  promptIdSupported?: boolean | (() => boolean);
  /** Prompt ids that timed out without the id guarantee; kept on disk. */
  uncertain?: { has: (id: string) => boolean; add: (id: string) => void };
};

/** The server says this session no longer exists; a bare 404 says nothing about it. */
const goneSession = (detail: string, ref: string) =>
  /not ?found/i.test(detail) &&
  (/session/i.test(detail) || detail.includes(ref));

/**
 * The prompt's OpenCode message id, the same on every attempt. OpenCode
 * returns the record it already holds for a known id instead of admitting a
 * second one, so a retry after a timed-out prompt never duplicates it. A
 * notice about a message has its own id, never the message's.
 */
const promptId = (msgId: string, ref: string, notice = false) =>
  `msg_oabus_${notice ? "notice_" : ""}${msgId}_${ref}`;

/** OpenCode's 409 for a prompt id it already holds (a reconcile/admit race). */
const heldAlready = (detail: string, id: string) =>
  /Prompt message ID conflicts/i.test(detail) &&
  detail.split(/[^\w-]+/).includes(id);

/**
 * Queues a prompt into an OpenCode session through `opencode api`. A queued
 * prompt wakes an idle session even with no TUI attached, so every call
 * re-reads presence first: a session no live TUI lists gets nothing.
 */
export class OpenCodeTransport {
  #missingLogged = false;
  readonly #uncertain: NonNullable<OpenCodeTransportOptions["uncertain"]>;

  constructor(private readonly opts: OpenCodeTransportOptions) {
    this.#uncertain = opts.uncertain ?? new Set<string>();
  }

  async deliver(agent: AgentRecord, mail: Mail): Promise<DeliverOutcome> {
    const header = {
      from: mail.from_name,
      to: agent.busName,
      namespace: mail.namespace,
      global: agent.global,
    };
    return this.#prompt(
      agent,
      promptId(mail.msg_id, agent.ref),
      // the bus's own oversized notice is not peer text: it is never escaped.
      mail.notice
        ? `${messageHeader(header)}\n\n${mail.body}`
        : deliveredText({ ...header, body: stripTerminalControls(mail.body) }),
    );
  }

  /** An Open Artifacts bus notice about mail `msgId` (expired or refused); never a message from a peer. */
  async notify(
    agent: AgentRecord,
    text: string,
    msgId: string,
  ): Promise<boolean> {
    const out = await this.#prompt(
      agent,
      promptId(msgId, agent.ref, true),
      `[oa-bus] ${text}`,
    );
    // Maybe told already: a second copy is worse than none.
    return out.ok || out.cause === "expired";
  }

  async #prompt(
    agent: AgentRecord,
    id: string,
    text: string,
  ): Promise<DeliverOutcome> {
    if (!this.opts.openSessions().has(agent.ref))
      return { ok: false, reason: "closed" };
    const supported = this.opts.promptIdSupported ?? true;
    const guarded = !(typeof supported === "function"
      ? supported()
      : supported);
    if (guarded && this.#uncertain.has(id))
      return { ok: false, reason: "closed", cause: "expired" };
    const args = [
      "api",
      "session.prompt",
      "--param",
      `sessionID=${agent.ref}`,
      "--data",
      JSON.stringify({ id, text, delivery: "queue" }),
    ];
    let res: Awaited<ReturnType<Spawn>>;
    try {
      res = await this.opts.spawn("opencode", args);
    } catch (e) {
      // Not installed where the daemon looks: no retry will find it; the session is fine.
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        if (!this.#missingLogged)
          this.opts.log?.(
            "opencode is not on the daemon's PATH; refusing OpenCode deliveries",
          );
        this.#missingLogged = true;
        return { ok: false, reason: "closed", cause: "dropped" };
      }
      this.opts.log?.(
        `opencode prompt failed to start: ${e instanceof Error ? e.message : String(e)}`,
      );
      return { ok: false, reason: "timeout" };
    }
    if (res.code === 0) return { ok: true };
    // It may have been admitted; without the id guarantee a retry could double it.
    if (res.code === null && guarded) this.#uncertain.add(id);
    // `opencode api` prints the status on stderr and the error body on stdout.
    const out = [res.stderr.trim(), res.stdout.trim()]
      .filter(Boolean)
      .join(" ");
    // Our id names this session, so a conflict on it means the prompt is already there.
    if (res.code !== null && heldAlready(out, id)) return { ok: true };
    const detail = out.slice(0, 300);
    // Only a session the server says is gone is closed; anything else may pass.
    if (res.code !== null && goneSession(out, agent.ref))
      return { ok: false, reason: "closed" };
    this.opts.log?.(
      `opencode prompt to ${agent.ref} ${res.code === null ? "timed out" : `exited ${res.code}`}: ${detail}`,
    );
    return { ok: false, reason: "timeout" };
  }
}
