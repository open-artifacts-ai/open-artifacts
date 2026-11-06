import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  BUS_ROUTES,
  DeviceCodeRequestSchema,
  DeviceCodeResponseSchema,
  DeviceTokenRequestSchema,
  DeviceTokenResponseSchema,
  newMachineLabel,
  verificationUriMatches,
} from "@oa/bus-protocol";
import { type Deps, realDeps } from "../deps.ts";
import { defaultMachineLabel } from "../machine-label.ts";

/** What install renders as the transcript; without it, login prints plain lines. */
export type LoginEvents = {
  /** A /bus/device attempt failed and another follows after `waitMs`. */
  retrying: (e: {
    attempt: number;
    total: number;
    waitMs: number;
    error: string;
  }) => void;
  /** The code is ready; `opened` is false when the browser did not start. */
  code: (e: {
    url: string;
    userCode: string;
    expiresIn: number;
    opened: boolean;
    noOpen: boolean;
  }) => void;
  /** A poll answered (true) or failed to reach the hub (false). */
  poll: (ok: boolean) => void;
};

type LoginArgs = {
  hub: string;
  home: string;
  /** Sent as machine_label and stored as the machine's label; defaults to the friendly machine name. */
  label?: string;
  noOpen?: boolean;
  /** Waits between /bus/device attempts (transcript state 6: 2, 4, 8 s). Default: one attempt. */
  codeRetryMs?: number[];
  events?: Partial<LoginEvents>;
  /** For the default label (macOS scutil); platform is for tests. */
  platform?: NodeJS.Platform;
} & Pick<Deps, "fetch" | "openBrowser" | "sleep" | "now"> &
  Partial<Pick<Deps, "print" | "exec">>;

/** A login that ended in one of the transcript's failure states. */
export class LoginFailed extends Error {
  constructor(
    readonly kind: "denied" | "expired" | "unreachable",
    message: string,
    readonly detail: {
      userCode?: string;
      attempts?: number;
      error?: string;
    } = {},
  ) {
    super(message);
  }
}

const CODE_TIMEOUT_MS = 10_000;

/** The muted tail of the unreachable line: a Node error code, `timeout`, or `HTTP 502`. */
export function errorTail(e: unknown): string {
  const err = e as { name?: string; code?: string; cause?: { code?: string } };
  if (err?.name === "TimeoutError" || err?.name === "AbortError")
    return "timeout";
  return err?.cause?.code ?? err?.code ?? "network error";
}

export type LoginResult = {
  machineToken: string;
  label: string;
  hub: string;
  home: string;
};

const POLL_MAX_BACKOFF_MS = 30_000;

const normalizeHub = (hub: string) => hub.replace(/\/+$/, "");

/**
 * Exactly the instance's approval page, `<origin>/bus/approve`, with no code
 * in it (RFC 8628 section 5.4); anything else is never opened or shown. The
 * person types the code this terminal shows.
 */
function checkVerificationUri(uri: string, hub: string): string {
  if (!verificationUriMatches(uri, hub))
    throw new Error(
      "bus/device returned a verification_uri that is not the instance's approval page",
    );
  return uri;
}

function writeMachineFile(home: string, body: string) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const tmp = join(home, `.machine.json.${randomBytes(8).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, body);
  } catch (e) {
    closeSync(fd);
    unlinkSync(tmp);
    throw e;
  }
  closeSync(fd);
  try {
    chmodSync(tmp, 0o600);
    // rename replaces a symlink at machine.json rather than following it.
    renameSync(tmp, join(home, "machine.json"));
  } catch (e) {
    unlinkSync(tmp);
    throw e;
  }
}

const post = (
  hub: string,
  fetch: Deps["fetch"],
  path: string,
  body: unknown,
  signal?: AbortSignal,
) =>
  fetch(`${hub}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

/** POST /bus/device, retried on a network error, a timeout or a 5xx. */
async function requestCode(
  args: LoginArgs,
  hub: string,
  label: string,
): Promise<Response> {
  const waits = args.codeRetryMs ?? [];
  const total = waits.length + 1;
  const body = DeviceCodeRequestSchema.parse({ machine_label: label });
  for (let attempt = 1; ; attempt++) {
    let error: string;
    try {
      const res = await post(
        hub,
        args.fetch,
        BUS_ROUTES.device,
        body,
        AbortSignal.timeout(CODE_TIMEOUT_MS),
      );
      if (res.status < 500 || total === 1) return res;
      error = `HTTP ${res.status}`;
    } catch (e) {
      if (total === 1) throw e;
      error = errorTail(e);
    }
    const waitMs = waits[attempt - 1];
    if (waitMs === undefined)
      throw new LoginFailed(
        "unreachable",
        `could not reach ${hub} after ${total} attempts: ${error}`,
        { attempts: total, error },
      );
    args.events?.retrying?.({ attempt, total, waitMs, error });
    await args.sleep(waitMs);
  }
}

export async function login(args: LoginArgs): Promise<LoginResult> {
  const print = args.print ?? realDeps.print;
  const hub = normalizeHub(args.hub);
  const label = newMachineLabel(
    args.label ??
      (await defaultMachineLabel({
        exec: args.exec ?? realDeps.exec,
        platform: args.platform,
      })),
  );
  const codeRes = await requestCode(args, hub, label);
  if (!codeRes.ok) {
    throw new Error(
      `bus/device failed: ${codeRes.status} ${(await codeRes.text()).slice(0, 200)}`,
    );
  }
  const device = DeviceCodeResponseSchema.parse(await codeRes.json());
  const url = checkVerificationUri(device.verification_uri, hub);

  const events = args.events;
  if (!events?.code)
    print(
      `Open ${url} and type this code to approve this machine: ${device.user_code}`,
    );
  const opened = args.noOpen ? false : await args.openBrowser(url);
  events?.code?.({
    url,
    userCode: device.user_code,
    expiresIn: device.expires_in,
    opened,
    noOpen: Boolean(args.noOpen),
  });

  const deadline = args.now() + device.expires_in * 1000;
  const baseMs = device.interval * 1000;
  // Bounds the loop even if the clock misbehaves.
  const maxPolls = Math.ceil(device.expires_in / device.interval) * 2;
  let waitMs = baseMs;
  for (let n = 0; n < maxPolls && args.now() < deadline; n++) {
    await args.sleep(waitMs);
    let res: Response;
    try {
      res = await post(
        hub,
        args.fetch,
        BUS_ROUTES.deviceToken,
        DeviceTokenRequestSchema.parse({ device_code: device.device_code }),
      );
    } catch {
      events?.poll?.(false);
      continue; // transient network error
    }
    if (res.status === 429) {
      waitMs = Math.min(waitMs * 2, POLL_MAX_BACKOFF_MS);
      continue;
    }
    if (res.status >= 500) {
      events?.poll?.(false);
      continue;
    }
    events?.poll?.(true);
    waitMs = baseMs;
    if (!res.ok) {
      throw new Error(
        `bus/device/token failed: ${res.status} ${(await res.text()).slice(0, 200)}`,
      );
    }
    const poll = DeviceTokenResponseSchema.parse(await res.json());
    switch (poll.status) {
      case "pending":
        continue;
      case "denied":
        throw new LoginFailed(
          "denied",
          "login denied: the approval was rejected",
        );
      case "expired":
        throw new LoginFailed(
          "expired",
          "device code expired; run the same command again",
          { userCode: device.user_code },
        );
      case "approved": {
        writeMachineFile(
          args.home,
          `${JSON.stringify({ hub, label, machine_token: poll.machine_token }, null, 2)}\n`,
        );
        // Approved again: the daemon's revoked marker no longer holds.
        rmSync(join(args.home, "revoked"), { force: true });
        if (!events?.code) print(`Approved this machine as ${label}.`);
        return {
          machineToken: poll.machine_token,
          label,
          hub,
          home: args.home,
        };
      }
    }
  }
  throw new LoginFailed(
    "expired",
    "device approval timed out; run the same command again",
    { userCode: device.user_code },
  );
}
