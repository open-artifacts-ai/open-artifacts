import { hostname as osHostname } from "node:os";
import type { Deps } from "./deps.ts";

export type LabelDeps = {
  platform?: NodeJS.Platform;
  hostname?: () => string;
  exec: Deps["exec"];
};

/** `host.tailnet.ts.net` or `box.corp.example.com` is `host` / `box`. */
const shortHost = (h: string): string => h.trim().split(".")[0] ?? "";

/**
 * The label a machine gets when none is asked for. On macOS the hostname is
 * often the Tailscale FQDN, so the name the user sees in Sharing settings
 * (ComputerName, else LocalHostName) wins. Elsewhere, or when scutil says
 * nothing, the hostname with any domain suffix trimmed.
 */
export async function defaultMachineLabel(d: LabelDeps): Promise<string> {
  if ((d.platform ?? process.platform) === "darwin") {
    for (const key of ["ComputerName", "LocalHostName"]) {
      try {
        const r = await d.exec("scutil", ["--get", key]);
        const v = r.stdout.trim();
        if (r.code === 0 && v) return v;
      } catch {}
    }
  }
  return shortHost((d.hostname ?? osHostname)());
}
