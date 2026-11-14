import { AUTH } from "@oa/shared";
import { api } from "../api/client";
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

/** POST logout, then go to /sign-in. On failure stay put and say so. */
export function useSignOut() {
  const redirect = useRedirect();
  return async () => {
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
