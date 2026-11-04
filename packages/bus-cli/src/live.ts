import type { Ctx } from "./context.ts";
import { spinnerFrame } from "./term.ts";

const FRAME_MS = 80;

/**
 * The lines redrawn in place on a TTY: the retry block, then the spinner.
 * clear() erases them before a result line prints.
 */
export function spinner(ctx: Pick<Ctx, "stdout" | "copy" | "style" | "now">) {
  let drawn = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let frame = 0;
  let failing = false;
  let deadline = 0;
  const draw = (lines: string[]) => {
    erase();
    for (const l of lines) ctx.stdout.write(`${l}\n`);
    drawn = lines.length;
  };
  const erase = () => {
    if (drawn > 0) ctx.stdout.write(`\x1b[${drawn}F\x1b[0J`);
    drawn = 0;
  };
  const tick = () =>
    draw([
      ctx.copy.waiting(
        spinnerFrame(ctx.style, frame++),
        deadline - ctx.now(),
        failing,
      ),
    ]);
  return {
    draw,
    spin: (until: number) => {
      deadline = until;
      tick();
      timer = setInterval(tick, FRAME_MS);
      timer.unref?.();
    },
    failing: (on: boolean) => {
      if (on === failing) return;
      failing = on;
      if (timer) tick();
    },
    clear: () => {
      clearInterval(timer);
      timer = undefined;
      erase();
    },
  };
}
