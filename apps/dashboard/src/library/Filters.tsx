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
  doc: "Doc",
};
// Radix items can't hold "", so "All" travels as a sentinel.
const ALL = "__all";
// The one-connection filter (agentVia) as the Agent select's value.
const VIA = "__via";
// Agent names are self-reported, so a name's value carries a prefix no
// sentinel has: an agent called "__via" or "__all" is still that agent.
const AGENT = "agent:";
const FORMATS = [
  { value: ALL, label: "All formats" },
  // #1100: no Doc filter until the doc editor lands.
  ...FormatSchema.options
    .filter((value) => value !== "doc")
    .map((value) => ({ value, label: LABEL[value] })),
];
const WAITING = [
  { value: ALL, label: "All" },
  { value: "needs_answer", label: "Needs your answer" },
];
const TEXT = "text-[length:var(--oa-text-sm)]";
const ITEM = `h-[30px] px-[var(--oa-space-3)] ${TEXT}`;

export type FilterProps = {
  format: Format | undefined;
  agent: string | undefined;
  agents: string[];
  /** #1535: the waiting-on filter. */
  waiting?: "needs_answer";
  onWaiting: (f: "needs_answer" | undefined) => void;
  /** The agentVia filter (#589) and its connection's name, shown in the Agent select. */
  via?: { label: string };
  view: "grid" | "list";
  onFormat: (f: Format | undefined) => void;
  /** An agent name, or undefined for All agents; either replaces `via`. */
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
        value={p.via ? VIA : p.agent ? `${AGENT}${p.agent}` : ALL}
        onValueChange={(v) => {
          if (v === ALL) p.onAgent(undefined);
          else if (v !== VIA) p.onAgent(v.slice(AGENT.length));
        }}
      >
        <SelectTrigger
          aria-label="Agent"
          size="sm"
          className={`max-w-full min-w-[140px] ${TEXT}`}
        >
          {/* A connection's label can run long. The value is a flex box, where
              text-overflow does nothing, so the text truncates in its own span. */}
          <SelectValue>
            <span className="block min-w-0 truncate">
              {p.via?.label ?? p.agent ?? "All agents"}
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value={ALL} className={TEXT}>
            All agents
          </SelectItem>
          {p.via && (
            <SelectItem value={VIA} className={TEXT}>
              {p.via.label}
            </SelectItem>
          )}
          {agents.map((a) => (
            <SelectItem key={a} value={`${AGENT}${a}`} className={TEXT}>
              {a}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would bring its own border and legend */}
      <div
        role="group"
        aria-label="Waiting on"
        className="flex flex-wrap gap-[var(--oa-space-2)]"
      >
        {WAITING.map((o) => {
          const on = (p.waiting ?? ALL) === o.value;
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={on}
              onClick={() =>
                p.onWaiting(
                  o.value === ALL ? undefined : (o.value as "needs_answer"),
                )
              }
              className={`h-7 rounded-full border px-[var(--oa-space-3)] ${TEXT} transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${on ? "border-transparent bg-[var(--oa-accent)] text-[var(--oa-accent-text)]" : "border-input bg-background text-foreground hover:bg-muted"}`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      {(p.format || p.agent || p.via || p.waiting) && (
        <Button variant="ghost" size="sm" className={TEXT} onClick={p.onClear}>
          Clear filters
        </Button>
      )}
      {/* ml-auto, not a spacer: it keeps Grid/List at the right on any line it wraps to. */}
      <div className="ml-auto">
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
    </div>
  );
}
