import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@oa/ui/shadcn";
import { type ReactNode, useId, useState } from "react";
import { ErrorLine } from "./Bits";

/**
 * A dialog for one write. `expected` makes it type-to-confirm: the button stays
 * off until the typed text matches exactly. `children` are extra fields.
 */
export function ActionDialog({
  open,
  onClose,
  title,
  description,
  expected,
  expectedLabel,
  submitLabel,
  destructive,
  canSubmit = true,
  pending,
  error,
  onSubmit,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  expected?: string;
  expectedLabel?: string;
  submitLabel: string;
  destructive?: boolean;
  canSubmit?: boolean;
  pending: boolean;
  error: unknown;
  onSubmit: () => void;
  children?: ReactNode;
}) {
  const [typed, setTyped] = useState("");
  const id = useId();
  const ok = (expected === undefined || typed === expected) && canSubmit;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setTyped("");
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form
          className="oa-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok && !pending) onSubmit();
          }}
        >
          {children}
          {expected !== undefined && (
            <div>
              <Label htmlFor={id}>
                {expectedLabel ?? "Type"} <code>{expected}</code> to confirm
              </Label>
              <Input
                id={id}
                value={typed}
                autoComplete="off"
                onChange={(e) => setTyped(e.target.value)}
              />
            </div>
          )}
          <ErrorLine error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={destructive ? "destructive" : "default"}
              disabled={!ok || pending}
            >
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
