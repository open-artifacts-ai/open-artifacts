// shadcn's Checkbox has no label prop (Design's #507 mapping): a Checkbox and
// its Label, side by side, 8px apart.
import { Checkbox, Label } from "@oa/ui/shadcn";

export function LabelledCheckbox({
  id,
  label,
  checked,
  disabled,
  describedBy,
  onCheckedChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  /** The id of a hint that explains it (and why it's off, when disabled). */
  describedBy?: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <span className="inline-flex items-center gap-[var(--oa-space-2)]">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        aria-describedby={describedBy}
        onCheckedChange={(on) => onCheckedChange(on === true)}
      />
      <Label
        htmlFor={id}
        className="text-[length:var(--oa-text-sm)] font-normal"
      >
        {label}
      </Label>
    </span>
  );
}
