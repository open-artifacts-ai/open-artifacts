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
