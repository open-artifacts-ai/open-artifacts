import { Button } from "@oa/ui/shadcn";
import { useState } from "react";

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** A small outline Copy button that says when the copy worked or failed. */
export function CopyButton({
  text,
  label = "Copy",
  ariaLabel,
}: {
  text: string;
  label?: string;
  ariaLabel?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={ariaLabel}
      onClick={async () => setState((await copy(text)) ? "copied" : "failed")}
    >
      {state === "copied"
        ? "Copied"
        : state === "failed"
          ? "Copy failed"
          : label}
    </Button>
  );
}
