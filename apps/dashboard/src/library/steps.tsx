// The first-run checklist's rows, shared by the owner's card (GetStarted)
// and a member's (MemberGetStarted, #2632).
import type { ReactNode } from "react";

const dot =
  "grid size-5 flex-none place-items-center rounded-full border-[1.5px] text-[length:var(--oa-text-xs)] font-semibold";

export function Step({
  n,
  state,
  title,
  children,
}: {
  /** The step number; absent on the optional row, which shows an empty circle. */
  n?: number;
  state: "done" | "cur" | "todo";
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <li
      data-state={state}
      aria-current={state === "cur" ? "step" : undefined}
      className="grid grid-cols-[20px_1fr] gap-x-[var(--oa-space-3)] gap-y-[var(--oa-space-1)] border-t border-border py-[var(--oa-space-3)]"
    >
      <span
        className={`${dot} ${
          state === "done"
            ? "border-[var(--oa-success)] bg-[var(--oa-success)] text-[var(--oa-accent-text)]"
            : state === "cur"
              ? "border-primary text-primary"
              : "border-border text-muted-foreground"
        }`}
        aria-hidden
      >
        {state === "done" ? "✓" : n}
      </span>
      <div
        className={`font-semibold ${state === "done" ? "text-muted-foreground line-through" : ""}`}
      >
        {title}
        {state === "done" && <span className="sr-only"> (done)</span>}
        {state === "cur" && <span className="sr-only"> (current step)</span>}
      </div>
      <div className="col-start-2 grid gap-[var(--oa-space-2)] text-[length:var(--oa-text-sm)] text-[var(--oa-text-2)]">
        {children}
      </div>
    </li>
  );
}

export const Waiting = ({ children }: { children: string }) => (
  <p
    role="status"
    className="m-0 text-[length:var(--oa-text-xs)] text-muted-foreground"
  >
    {children}
  </p>
);
