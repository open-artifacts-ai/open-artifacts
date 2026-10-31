import type { ReactNode } from "react";

export function EdgePanel({ children }: { children: ReactNode }) {
  return (
    <div className="oa-edge">
      <main className="oa-panel">{children}</main>
    </div>
  );
}
