import type { ReactNode } from "react";
import { useMe } from "../auth/useMe";
import { UserAvatar } from "../layout/UserAvatar";

/** Centered card shared by the edge pages. */
export function EdgePanel({ children }: { children: ReactNode }) {
  return (
    <div className="oa-edge">
      <section className="oa-panel">{children}</section>
    </div>
  );
}

export function SignedInAs() {
  const state = useMe();
  if (state.status !== "authed") return null;
  const { email, name } = state.me.user;
  return (
    <div className="oa-who">
      <UserAvatar name={name ?? undefined} email={email} size={32} />
      <div>
        <small>Logged in as</small>
        <b>{email}</b>
      </div>
    </div>
  );
}
