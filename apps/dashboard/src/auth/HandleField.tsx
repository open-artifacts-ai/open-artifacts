import { HandleAvailabilitySchema, PersonHandleSchema, R } from "@oa/shared";
import { Input, Label } from "@oa/ui/shadcn";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { api } from "../api/client";

export function HandleField({
  value,
  saved,
  onChange,
}: {
  value: string;
  saved?: string | null;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const parsed = PersonHandleSchema.safeParse(value);
  const handle = parsed.success ? parsed.data : "";
  const check = useQuery({
    queryKey: ["handle-availability", handle],
    enabled: Boolean(handle && handle !== saved),
    retry: false,
    queryFn: ({ signal }) =>
      api.get(
        R.meHandle + "?handle=" + encodeURIComponent(handle),
        HandleAvailabilitySchema,
        signal,
      ),
  });
  const result = handle && handle !== saved ? check.data : undefined;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>Handle</Label>
      <div className="relative">
        <span
          aria-hidden="true"
          className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        >
          @
        </span>
        <Input
          id={id}
          value={value}
          autoCapitalize="none"
          spellCheck={false}
          className="pl-7"
          aria-invalid={
            !parsed.success || result?.available === false || undefined
          }
          aria-describedby={id + "-help"}
          onChange={(e) => onChange(e.target.value.toLowerCase())}
        />
      </div>
      <p id={id + "-help"} className="text-xs text-muted-foreground">
        {saved && saved === handle
          ? `People and agents use @${handle} to mention you. Old mentions still work after a change.`
          : "2 to 30 letters, numbers, dots, dashes or underscores."}
      </p>
      <div aria-live="polite" className="text-xs">
        {result &&
          (result.available ? (
            <span className="text-[var(--oa-success-fg)]">
              @{handle} is available
            </span>
          ) : (
            <span className="text-destructive">
              @{handle} is taken. Try{" "}
              <button
                type="button"
                className="underline"
                onClick={() => result.suggestion && onChange(result.suggestion)}
              >
                @{result.suggestion}
              </button>
            </span>
          ))}
      </div>
    </div>
  );
}
