import { api } from "../api/client";

/** POST /auth/logout (with x-csrf-token from /me), then a full-page navigation to `to`. */
export async function signOut(to: string) {
  try {
    await api.logout();
  } catch {
    // Navigate anyway; a failed logout means there was no session to end.
  }
  window.location.assign(to);
}
