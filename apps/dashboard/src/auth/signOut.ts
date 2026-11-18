import { AUTH } from "@oa/shared";
import { api } from "../api/client";
import { forgetThisBrowser } from "../foryou/push";
import { toast } from "../layout/toast";
import { useRedirect } from "./redirect";

/** Forgets every "Not now" on the display-name dialog, so the next sign-in asks again. */
export function clearDisplayNameSkips() {
  try {
    for (const k of Object.keys(sessionStorage))
      if (k.startsWith("oa:display-name-skipped:"))
        sessionStorage.removeItem(k);
  } catch {
    // Storage blocked: nothing was stored.
  }
}

/**
 * Turn this browser's notifications off (Axe M1, best effort, bounded), POST
 * logout, then go to /sign-in. On a logout failure stay put and say so. Every
 * sign-out goes through here.
 */
export function useSignOut() {
  const redirect = useRedirect();
  return async () => {
    // While the session still exists, so the server can delete it.
    await forgetThisBrowser();
    try {
      await api.send("POST", AUTH.logout, undefined);
    } catch {
      toast({
        title: "Couldn't log out",
        description: "Try again.",
        tone: "danger",
      });
      return;
    }
    clearDisplayNameSkips();
    redirect("/sign-in");
  };
}
