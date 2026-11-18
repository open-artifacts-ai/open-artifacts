// An on/off switch (role="switch"): a button whose aria-checked is the state.
export function Switch({
  label,
  checked,
  disabled,
  onChange,
  describedBy,
  labelledBy,
  id,
}: {
  id?: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  describedBy?: string;
  /** A visible label's id: the name comes from it, `label` stays the fallback. */
  labelledBy?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-checked={checked}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative inline-flex h-[22px] w-[38px] flex-none items-center rounded-full border border-transparent bg-input transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50 aria-checked:bg-primary"
    >
      <span
        aria-hidden="true"
        className={`inline-block size-[18px] rounded-full bg-background shadow-sm transition-transform ${checked ? "translate-x-[17px]" : "translate-x-[1px]"}`}
      />
    </button>
  );
}
