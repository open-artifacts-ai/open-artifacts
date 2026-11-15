import { label, readPolicy, setIntroShown, setOff } from "@oa/bus-daemon";
import { type Ctx, say } from "../context.ts";

/**
 * `oa-bus auto-update off|on|status` (#2552). The only place `off` is written:
 * nothing the instance sends can reach it.
 */
export async function autoUpdate(
  opts: { sub: "off" | "on" | "status" },
  ctx: Ctx,
): Promise<number> {
  const c = ctx.copy;
  if (opts.sub === "off") {
    setOff(ctx.home, true);
    say(ctx, c.autoUpdateOff());
    return 0;
  }
  if (opts.sub === "on") {
    setOff(ctx.home, false);
    say(ctx, c.autoUpdateOn());
    return 0;
  }
  const s = readPolicy(ctx.home);
  if (!s.introShown && !s.unreadable) {
    say(ctx, c.autoUpdateIntro());
    setIntroShown(ctx.home);
  }
  say(
    ctx,
    s.off ? c.autoUpdateStatusOff() : c.autoUpdateLabel(label(s, ctx.now())),
  );
  return 0;
}
