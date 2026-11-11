import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";

/**
 * #1711: the action row belongs to the sheet, not to the card it describes.
 * A card's composer claims the sheet's outlet while the sheet is short (a
 * pin's card), so the row floats at the bottom for a long thread scrolled to
 * its top. Anywhere else the row stays in the card.
 */
type Slot = { node: HTMLElement | null; holder: string | null };
type Control = {
  claim: (id: string) => void;
  release: (id: string) => void;
  setNode: (node: HTMLElement | null) => void;
};

const SlotContext = createContext<Slot | null>(null);
const ControlContext = createContext<Control | null>(null);

/** Carried by the sheet whose scroller owns an outlet. */
export function ActionRowProvider({ children }: { children: ReactNode }) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [holder, setHolder] = useState<string | null>(null);
  const claim = useCallback((id: string) => setHolder(id), []);
  const release = useCallback(
    (id: string) => setHolder((h) => (h === id ? null : h)),
    [],
  );
  const control = useMemo(
    () => ({ claim, release, setNode }),
    [claim, release],
  );
  const slot = useMemo(() => ({ node, holder }), [node, holder]);
  return (
    <ControlContext.Provider value={control}>
      <SlotContext.Provider value={slot}>{children}</SlotContext.Provider>
    </ControlContext.Provider>
  );
}

/**
 * Where this composer's action row should render: the sheet's outlet node
 * once it has claimed it, or `null` to keep the row in the card.
 */
export function useActionRowSlot(active: boolean): HTMLElement | null {
  const slot = useContext(SlotContext);
  const control = useContext(ControlContext);
  const id = useId();
  const mine = active && control !== null;
  useEffect(() => {
    if (!mine || !control) return;
    control.claim(id);
    return () => control.release(id);
  }, [mine, control, id]);
  return mine && slot?.holder === id ? slot?.node : null;
}

/**
 * The sheet's own row slot: a child of its scroller, stuck to the bottom edge
 * and clear of a phone's home indicator. Empty and out of the flow until a
 * composer claims it.
 */
export function ActionRowOutlet() {
  const slot = useContext(SlotContext);
  const control = useContext(ControlContext);
  if (!control) return null;
  return (
    <div
      ref={control.setNode}
      data-oa-action-outlet=""
      className={
        slot?.holder
          ? // `mt-auto`: a short list leaves the row at the sheet's bottom
            // edge, where `sticky bottom-0` keeps it for a long one.
            "sticky bottom-0 z-10 mt-auto flex flex-col gap-2 border-0 border-t border-t-border bg-card px-4 pt-3 pb-[calc(0.75rem_+_env(safe-area-inset-bottom))]"
          : "hidden"
      }
    />
  );
}
