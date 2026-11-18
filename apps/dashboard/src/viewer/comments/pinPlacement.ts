/** The box's width: 320px, less on a narrow frame. */
export const besideWidth = (frameW: number) =>
  Math.max(220, Math.min(320, frameW - 16));

const MARGIN = 8;
/** The flag is 30px wide and tall; the box clears it by 10px. */
const FLAG = 30;
const GAP = 10;

/**
 * #2019: where the box for a new pin goes, in the frame's pixels. Right of the
 * flag and level with it; past the right edge it flips to the left of the
 * flag, and it is always clamped so every edge is in view.
 */
export function placeBeside(
  at: { x: number; y: number },
  frame: { w: number; h: number },
  box: { w: number; h: number },
): { left: number; top: number } {
  const right = at.x + FLAG + GAP;
  const left =
    right + box.w > frame.w - MARGIN ? at.x - FLAG - GAP - box.w : right;
  return {
    left: Math.max(MARGIN, Math.min(left, frame.w - box.w - MARGIN)),
    top: Math.max(MARGIN, Math.min(at.y - FLAG - 4, frame.h - box.h - MARGIN)),
  };
}

/**
 * #2426: where an ask's card goes beside the mark it is about, in the frame's
 * pixels. Below the mark (so it leaves the quote readable), else above, else
 * right, else left; always clamped so every edge is in view, which also holds
 * on a 390px phone-width frame.
 */
export function placeBesideRect(
  r: { x: number; y: number; width: number; height: number },
  frame: { w: number; h: number },
  box: { w: number; h: number },
): { left: number; top: number } {
  const clampX = (x: number) =>
    Math.max(MARGIN, Math.min(x, frame.w - box.w - MARGIN));
  const clampY = (y: number) =>
    Math.max(MARGIN, Math.min(y, frame.h - box.h - MARGIN));
  const below = r.y + r.height + GAP;
  if (below + box.h <= frame.h - MARGIN)
    return { left: clampX(r.x), top: below };
  const above = r.y - GAP - box.h;
  if (above >= MARGIN) return { left: clampX(r.x), top: above };
  const right = r.x + r.width + GAP;
  if (right + box.w <= frame.w - MARGIN)
    return { left: right, top: clampY(r.y) };
  return { left: clampX(r.x - GAP - box.w), top: clampY(r.y) };
}
