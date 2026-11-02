import { safeReturn } from "../auth/safeReturn";
import { AUTH_START } from "./client";

/** The fresh sign-in URL (R22 reauth=1) that comes back to `path`. */
export const reauthHref = (path: string) =>
  `${AUTH_START}?reauth=1&return=${encodeURIComponent(safeReturn(path))}`;
