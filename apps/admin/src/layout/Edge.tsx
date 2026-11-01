import type { ReactNode } from "react";

/** Sign-in and no-access: the mock's .cpage, a brand bar over a top-aligned card. */
export function EdgePanel({ children }: { children: ReactNode }) {
  return (
    <div className="oa-edge">
      <header className="oa-chead">
        Open Artifacts admin
        <span className="oa-mono oa-host">{window.location.host}</span>
      </header>
      <main className="oa-panel">{children}</main>
    </div>
  );
}
