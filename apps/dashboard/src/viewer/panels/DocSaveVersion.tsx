import { Input, Button as ShButton } from "@oa/ui/shadcn";
import { useState } from "react";
import { ApiClientError } from "../../api/client";
import { useDocSaveVersion } from "../../api/queries";
import { useSingleFlight } from "../../api/useSingleFlight";
import { toast } from "../../layout/toast";
import {
  defaultVersionName,
  SAVE_FAILED_FALLBACK,
  SAVE_VERSION,
  SAVE_VERSION_NOTE,
  savedToast,
  VERSION_NAME_LABEL,
  VERSION_NAME_PLACEHOLDER,
} from "../doc/versions";
import { SM, TXT } from "../ui";

/** The server's limit on a version name (PROVISIONAL, #2496). */
const MAX_NAME = 100;

/**
 * "Save version" on a doc (#1100): a named version of the doc as it is now,
 * at the top of the Versions panel, for people who may edit.
 */
export function DocSaveVersion({ id }: { id: string }) {
  const [name, setName] = useState("");
  const save = useDocSaveVersion(id);
  const once = useSingleFlight();
  const submit = () =>
    once((done) => {
      const typed = name.trim() || undefined;
      // mutateAsync: the panel remounts as the new version lands, which
      // would drop mutate()'s own callbacks.
      save
        .mutateAsync(typed)
        .then((r) => {
          setName("");
          toast({
            title: savedToast(
              typed ?? defaultVersionName(r.version),
              r.version,
            ),
            tone: "neutral",
          });
        })
        .catch((e: unknown) =>
          toast({
            title:
              e instanceof ApiClientError ? e.message : SAVE_FAILED_FALLBACK,
            tone: "danger",
          }),
        )
        .finally(done);
    });
  return (
    <form
      className="grid gap-2 border-0 border-b border-solid border-border px-4 pt-3 pb-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Input
        aria-label={VERSION_NAME_LABEL}
        placeholder={VERSION_NAME_PLACEHOLDER}
        maxLength={MAX_NAME}
        className={`${TXT} max-[600px]:h-11`}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-[length:var(--oa-text-xs)] text-muted-foreground">
          {SAVE_VERSION_NOTE}
        </span>
        <ShButton
          type="submit"
          size="xs"
          className={`${SM} max-[600px]:h-11`}
          disabled={save.isPending}
        >
          {SAVE_VERSION}
        </ShButton>
      </div>
    </form>
  );
}
