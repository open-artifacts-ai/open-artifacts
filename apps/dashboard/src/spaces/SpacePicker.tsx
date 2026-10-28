// The "Space" select in the upload dialog (Design D4, 2026-10-22): Personal
// first, then the shared spaces you can publish to, by name. Spaces you can't
// publish to are hidden (canPublishTo); a capped caller gets none.
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@oa/ui/shadcn";
import { useId } from "react";
import { canPublishTo, useHosted } from "../auth/permissions";
import { sharedSpaceName } from "./label";

export function SpacePicker({
  value,
  onChange,
  label = "Space",
}: {
  value: string | undefined;
  onChange: (id: string) => void;
  label?: string;
}) {
  const { spaces, personalSpaceId, cap } = useHosted();
  const id = useId();
  const options = [
    ...(personalSpaceId && canPublishTo({ kind: "personal", myRole: null }, cap)
      ? [{ value: personalSpaceId, label: "Personal" }]
      : []),
    ...spaces
      .filter((s) => canPublishTo(s, cap))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => ({ value: s.id, label: sharedSpaceName(s.name) })),
  ];
  return (
    <div>
      <span id={`${id}-label`} className="up-entry-label">
        {label}
      </span>
      <Select value={value ?? ""} onValueChange={onChange}>
        <SelectTrigger
          aria-labelledby={`${id}-label`}
          size="sm"
          className="w-full text-[length:var(--oa-text-sm)]"
        >
          <SelectValue placeholder="Choose a space" />
        </SelectTrigger>
        <SelectContent position="popper">
          {options.map((o) => (
            <SelectItem
              key={o.value}
              value={o.value}
              className="text-[length:var(--oa-text-sm)]"
            >
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <small id={`${id}-help`} className="up-help">
        {value && value === personalSpaceId
          ? "Only you, and anyone you share it with."
          : "People in this space get access by their role."}
      </small>
    </div>
  );
}

/** Where an upload starts: the open space when you can publish there, else Personal. */
export const useUploadSpace = (current: string | undefined) => {
  const { spaces, personalSpaceId, cap } = useHosted();
  if (current && current === personalSpaceId) return personalSpaceId;
  const s = current ? spaces.find((x) => x.id === current) : undefined;
  return s && canPublishTo(s, cap) ? s.id : (personalSpaceId ?? undefined);
};
