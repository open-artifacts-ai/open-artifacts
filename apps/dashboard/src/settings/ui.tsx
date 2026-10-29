// Shared shadcn layout for the settings cards (Design: cards pad 20px,
// 16px at <= 600px; 12px from header to body; 16px between cards).

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Button as ShButton,
} from "@oa/ui/shadcn";
import type { ReactNode } from "react";
import { READ_ONLY_NOTICE } from "../api/errorCopy";
import { useFrozen } from "../auth/permissions";
import { toast } from "../layout/toast";

/** The settings pages' 880px measure, centered in the shell gutter. */
export const MEASURE = "mx-auto max-w-[880px]";
/** The card: its vertical padding and the header-to-body gap. */
export const CARD =
  "gap-[var(--oa-space-3)] py-[var(--oa-space-5)] shadow-none max-[600px]:py-[var(--oa-space-4)]";
/** The card's horizontal padding, on its header, content and footer. */
export const INSET =
  "px-[var(--oa-space-5)] max-[600px]:px-[var(--oa-space-4)]";
/** One vertical rhythm inside a card. */
export const GAP = "gap-[var(--oa-space-3)]";
/** Cards stack 16px apart. */
export const STACK = "grid min-w-0 grid-cols-1 gap-[var(--oa-space-4)]";

export const muted = "text-[length:var(--oa-text-xs)] text-muted-foreground";
export const errorText = "text-[length:var(--oa-text-sm)] text-destructive";

export function SettingsCard({
  id,
  title,
  action,
  children,
}: {
  id: string;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="min-w-0">
      <Card className={CARD}>
        <CardHeader
          className={`flex min-h-[30px] items-center justify-between ${GAP} ${INSET}`}
        >
          <CardTitle>
            <h2
              id={id}
              className="text-[length:var(--oa-text-md)] font-semibold"
            >
              {title}
            </h2>
          </CardTitle>
          {action}
        </CardHeader>
        <CardContent className={`grid min-w-0 ${GAP} ${INSET}`}>
          {children}
        </CardContent>
      </Card>
    </section>
  );
}

export const copyText = (text: string, ok: string) => {
  const failed = () =>
    toast({
      title: "Couldn't copy",
      description: "Select it and copy it yourself.",
      tone: "danger",
    });
  if (!navigator.clipboard) return failed();
  navigator.clipboard
    .writeText(text)
    .then(() => toast({ title: ok, tone: "success" }), failed);
};

/** Code with its Copy button beside it (never over it); no outer padding, so
    it fits a card or a dialog. */
export function CodeBlock({
  children,
  copy,
  label,
}: {
  children: ReactNode;
  copy: string;
  label: string;
}) {
  return (
    <div className="flex min-w-0 items-start gap-[var(--oa-space-1)] rounded-md bg-secondary">
      {children}
      <ShButton
        variant="ghost"
        size="sm"
        className="m-[var(--oa-space-1)] flex-none text-[length:var(--oa-text-sm)]"
        aria-label={label}
        onClick={() => copyText(copy, "Copied")}
      >
        Copy
      </ShButton>
    </div>
  );
}

/** `wrap` breaks long lines (anywhere) instead of scrolling them. */
export function Code({
  code,
  label,
  wrap = false,
}: {
  code: string;
  label: string;
  wrap?: boolean;
}) {
  return (
    <CodeBlock copy={code} label={label}>
      <pre
        // Focusable so keyboard users can scroll a long line (wrapped ones
        // don't scroll).
        tabIndex={wrap ? undefined : 0}
        className={`min-w-0 flex-1 p-[var(--oa-space-3)] font-mono text-[length:var(--oa-text-xs)] ${
          wrap
            ? "[overflow-wrap:anywhere] whitespace-pre-wrap"
            : "overflow-x-auto"
        }`}
      >
        <code>{code}</code>
      </pre>
    </CodeBlock>
  );
}

/**
 * A settings page's write surface. Under the plan cap the fieldset turns
 * every control inside off and one muted line says why; lists stay visible.
 */
export function WriteLock({ children }: { children: ReactNode }) {
  const frozen = useFrozen();
  return (
    <fieldset
      disabled={frozen}
      className="m-0 grid min-w-0 gap-[var(--oa-space-3)] border-0 p-0"
    >
      {frozen && (
        <p role="status" className={`m-0 ${muted}`}>
          {READ_ONLY_NOTICE}
        </p>
      )}
      {children}
    </fieldset>
  );
}
