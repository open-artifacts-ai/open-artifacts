import { useEffect } from "react";
import { useMe } from "../auth/useMe";

const APP = "Open Artifacts";

/** The server's `<meta name="oa-instance">`, for visitors not signed in. */
function metaName(): string {
  if (typeof document === "undefined") return "";
  return (
    document
      .querySelector('meta[name="oa-instance"]')
      ?.getAttribute("content")
      ?.trim() ?? ""
  );
}

/** The meta tag's instance name, else "Open Artifacts": for screens that mustn't observe /me. */
export const metaInstanceName = (): string => metaName() || APP;

/** Instance name from /me, else the shell's meta tag, else "Open Artifacts". */
export function useInstanceName(): string {
  const state = useMe();
  return (
    (state.status === "authed" && state.me.instance.name) || metaName() || APP
  );
}

/**
 * Sets `document.title` to "<page> · <instance name>" while mounted. `null` leaves it alone, so a page
 * still loading never overrides a child (e.g. NotFound).
 */
export function useDocumentTitle(page: string | null) {
  const name = useInstanceName();
  useEffect(() => {
    if (!page) return;
    document.title = `${page} · ${name}`;
    return () => {
      document.title = name;
    };
  }, [page, name]);
}
