// `oa-bus skill`: saves this instance's skill for the harnesses found here, and
// nothing else: no login, no daemon, no service, no harness wiring. It works
// when the bus install was refused or failed, because it needs only the
// instance's origin. `--check` reads and changes nothing.
import { readFileSync } from "node:fs";
import { codexBinFile } from "@oa/bus-daemon";
import { type Ctx, say, sayErr, tilde } from "../context.ts";
import { originOf, readMachine } from "../machine.ts";
import { checkAdapters, type Harness } from "../steps/adapters.ts";
import { readCodexVersion } from "../steps/codex.ts";
import {
  fetchSkillText,
  installSkill,
  savedSkill,
  skillFolder,
  skillVersion,
} from "../steps/skill.ts";

type Opts = { hub?: string; check: boolean; json?: boolean };

/** Harnesses found on this machine, wired or not: the skill does not need the bus. */
const detected = (ctx: Ctx): Harness[] =>
  (
    Object.entries(
      checkAdapters({
        home: ctx.userHome,
        busHome: ctx.home,
        env: ctx.env,
        which: ctx.which,
        codexApp: ctx.codexApp,
      }),
    ) as [Harness, string][]
  )
    .filter(([, st]) => st !== "absent")
    .map(([h]) => h);

export async function skill(opts: Opts, ctx: Ctx): Promise<number> {
  const machine = readMachine(ctx.home);
  const asked = opts.hub ?? ctx.env.OA_BUS_INSTANCE;
  const origin = asked
    ? originOf(asked)
    : machine.state === "ok"
      ? originOf(machine.hub)
      : undefined;
  const log = opts.json ? sayErr : say;
  if (!origin) {
    sayErr(ctx, [
      "No instance to take the skill from.",
      `Run ${ctx.busCmd} skill --instance <url>.`,
    ]);
    return 1;
  }
  const harnesses = detected(ctx);
  if (harnesses.length === 0) {
    sayErr(ctx, [
      "No harness the bus knows was found here.",
      `Save ${origin}/skill.md the way your harness keeps skills.`,
    ]);
    return 1;
  }
  const deps = {
    home: ctx.userHome,
    env: ctx.env,
    fetchSkill: (url: string) => fetchSkillText(ctx.fetch, url),
    codexVersion: harnesses.includes("codex")
      ? await readCodexVersion({
          configFile: codexBinFile(ctx.home),
          exec: ctx.exec,
          path: ctx.env.PATH,
          app: ctx.codexApp,
        })
      : undefined,
  };
  let failedUrl: string | undefined;
  if (!opts.check) {
    const r = await installSkill(deps, origin, harnesses);
    for (const n of r.notes) sayErr(ctx, n);
    failedUrl = r.failedUrl;
    if (failedUrl) sayErr(ctx, `Could not fetch the skill from ${failedUrl}.`);
  }
  // Only this instance's own copy counts, so its folder name must be known.
  let liveText: string;
  let folder: string | undefined;
  try {
    liveText = await deps.fetchSkill(`${origin}/skill.md`);
    folder = skillFolder(liveText);
    if (!folder) throw new Error("no skill name in the file");
  } catch (e) {
    sayErr(
      ctx,
      `Could not read this instance's skill from ${origin}/skill.md (${e instanceof Error ? e.message : String(e)}), so I can't check it is the one saved.`,
    );
    return 1;
  }
  const liveVersion = skillVersion(liveText);
  const where = Object.fromEntries(
    harnesses.map((h) => [h, savedSkill(deps, h, folder)]),
  ) as Record<Harness, string | undefined>;
  let ok = !failedUrl;
  for (const h of harnesses) {
    const path = where[h];
    if (path) {
      let savedVersion: string | undefined;
      if (liveVersion) {
        try {
          savedVersion = skillVersion(readFileSync(path, "utf8"));
        } catch {
          // Unreadable file: say nothing extra.
        }
      }
      if (liveVersion && savedVersion && savedVersion !== liveVersion) {
        ok = false;
        sayErr(
          ctx,
          `${h}: skill at ${tilde(ctx, path)} is ${savedVersion}, the instance has ${liveVersion}. Run ${ctx.busCmd} skill to update it.`,
        );
      } else {
        log(ctx, `${h}: skill saved at ${tilde(ctx, path)}`);
      }
    } else {
      ok = false;
      sayErr(
        ctx,
        `${h}: no Open Artifacts skill saved. Run ${ctx.busCmd} skill --instance ${origin} to save it.`,
      );
    }
  }
  if (opts.json)
    ctx.stdout.write(
      `${JSON.stringify({ ok, origin, harnesses: Object.fromEntries(harnesses.map((h) => [h, where[h] ?? null])) })}\n`,
    );
  return ok ? 0 : 1;
}
