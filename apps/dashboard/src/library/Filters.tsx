import { type Format, FormatSchema } from "@oa/shared";
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  ToggleGroup,
  ToggleGroupItem,
} from "@oa/ui/shadcn";
import { BAR } from "./ui";

const LABEL: Record<Format, string> = {
  html: "HTML",
  markdown: "Markdown",
  code: "Code",
  pdf: "PDF",
  image: "Image",
};
// Radix items can't hold "", so "All" travels as a sentinel.
const ALL = "__all";
const FORMATS = [
  { value: ALL, label: "All formats" },
  ...FormatSchema.options.map((value) => ({ value, label: LABEL[value] })),
];
const TEXT = "text-[length:var(--oa-text-sm)]";
const ITEM = `h-[30px] px-[var(--oa-space-3)] ${TEXT}`;

export type FilterProps = {
  format: Format | undefined;
  agent: string | undefined;
  agents: string[];
  view: "grid" | "list";
  onFormat: (f: Format | undefined) => void;
  onAgent: (a: string | undefined) => void;
  onClear: () => void;
  onView: (v: "grid" | "list") => void;
};

/** A single-choice switch: a toggle group that never deselects. */
function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      aria-label={label}
      className={className}
      value={value}
      onValueChange={(v) => v && onChange(v as T)}
    >
      {options.map((o) => (
        <ToggleGroupItem key={o.value} value={o.value} className={ITEM}>
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export function Filters(p: FilterProps) {
  const agents =
    p.agent && !p.agents.includes(p.agent) ? [...p.agents, p.agent] : p.agents;
  return (
    <div className={BAR}>
      {/* Six formats don't fit a phone as toggles: a select there, like Agent. */}
      <Choice
        label="Format"
        options={FORMATS}
        value={p.format ?? ALL}
        onChange={(v) => p.onFormat(v === ALL ? undefined : (v as Format))}
        className="max-[600px]:hidden"
      />
      <Select
        value={p.format ?? ALL}
        onValueChange={(v) => p.onFormat(v === ALL ? undefined : (v as Format))}
      >
        <SelectTrigger
          aria-label="Format"
          size="sm"
          className={`min-w-[140px] min-[601px]:hidden ${TEXT}`}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          {FORMATS.map((f) => (
            <SelectItem key={f.value} value={f.value} className={TEXT}>
              {f.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={p.agent ?? ALL}
        onValueChange={(v) => p.onAgent(v === ALL ? undefined : v)}
      >
        <SelectTrigger
          aria-label="Agent"
          size="sm"
          className={`min-w-[140px] ${TEXT}`}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value={ALL} className={TEXT}>
            All agents
          </SelectItem>
          {agents.map((a) => (
            <SelectItem key={a} value={a} className={TEXT}>
              {a}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {(p.format || p.agent) && (
        <Button variant="ghost" size="sm" className={TEXT} onClick={p.onClear}>
          Clear filters
        </Button>
      )}
      <span className="flex-1" />
      <Choice
        label="Layout"
        options={[
          { value: "grid", label: "Grid" },
          { value: "list", label: "List" },
        ]}
        value={p.view}
        onChange={p.onView}
      />
    </div>
  );
}
