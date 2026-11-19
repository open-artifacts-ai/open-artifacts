import {
  canonicalAddress,
  coveringEntry,
  type Folders,
  folderKey,
  foldersFile,
  inspectFolders,
  instanceAt,
  listInstances,
  readSuggestion,
  writeFolders,
} from "@oa/bus-daemon";
import { type Ctx, say, sayErr, tilde } from "../context.ts";
import { showAddress } from "./add.ts";

const SHOWN_MAX = 120;

/** A path as the terminal may show it: controls stripped. */
const clean = showAddress;

/**
 * `oa-bus use [name]` and `oa-bus use --none`: tie this folder (its git repo
 * root, else the folder) to one added instance, or turn down what the repo
 * suggests. Terminal only: a person reads the addresses and answers. The
 * repo's `instance` hint is a hint, never a default: it changes nothing until
 * the person picks it, and it makes no request.
 */
export async function use(
  opts: { name?: string; none: boolean },
  ctx: Ctx,
): Promise<number> {
  if (!ctx.stdinIsTTY || !ctx.stdout.isTTY) {
    sayErr(
      ctx,
      "Nothing changed: use needs a real terminal; run it yourself, not from a script or an agent.",
    );
    return 1;
  }
  const list = listInstances(ctx.home);
  if (list.length === 1 && list[0]?.main) {
    say(
      ctx,
      `Only the main instance is set up on this computer, so every folder uses it. Add another with ${ctx.busCmd} add <address>.`,
    );
    return 0;
  }
  const key = folderKey(ctx.cwd);
  const { folders: f, unusable } = inspectFolders(ctx.home);
  if (unusable) {
    sayErr(
      ctx,
      `Nothing changed: ${tilde(ctx, foldersFile(ctx.home))} can't be read safely, so it is left as it is. Fix or remove it, then run ${ctx.busCmd} use again.`,
    );
    return 1;
  }
  const covering = coveringEntry(f, key);
  const found = readSuggestion(
    ctx.cwd,
    covering ? { below: covering.dir } : {},
  );
  const suggestion =
    found !== undefined && showAddress(found).length <= SHOWN_MAX
      ? found
      : undefined;
  if (found !== undefined && suggestion === undefined)
    say(
      ctx,
      "This repo suggests an address that is too long to show. Ignored.",
    );
  const answered = covering !== undefined || f.no[key] !== undefined;
  const save = (next: Folders) => writeFolders(next, ctx.home);

  // A suggestion that changed after the folder was settled moves nothing: one note per new value.
  if (suggestion !== undefined && answered && f.seen[key] !== suggestion) {
    say(
      ctx,
      `This repo now suggests ${showAddress(suggestion)}. Nothing changed: this folder keeps its answer.`,
    );
    f.seen[key] = suggestion;
    save(f);
  }
  const open =
    suggestion !== undefined && !answered && f.no[key] !== suggestion
      ? suggestion
      : undefined;

  if (opts.none) {
    if (open === undefined) {
      say(ctx, "This repo has no suggestion waiting. Nothing changed.");
      return 0;
    }
    f.no[key] = open;
    f.seen[key] = open;
    save(f);
    say(ctx, "Noted. This repo's suggestion will not be offered here again.");
    return 0;
  }

  const added = open === undefined ? undefined : instanceAt(open, list);
  if (open !== undefined && !added)
    say(
      ctx,
      `This repo suggests ${showAddress(open)}, which this computer hasn't added. Run ${ctx.busCmd} add yourself if you trust it.`,
    );

  const pick = (name: string): number => {
    f.map[key] = name;
    if (open !== undefined) f.seen[key] = open;
    delete f.no[key];
    save(f);
    say(ctx, `Done. ${clean(key)} now uses ${name}.`);
    return 0;
  };

  if (opts.name !== undefined) {
    if (!list.some((i) => i.name === opts.name)) {
      sayErr(
        ctx,
        `Nothing changed: there is no instance named ${opts.name} on this computer. Run ${ctx.busCmd} use to see them.`,
      );
      return 1;
    }
    const named = list.find((i) => i.name === opts.name);
    if (named && canonicalAddress(named.hub) === undefined) {
      sayErr(
        ctx,
        `Nothing changed: the address of ${opts.name} can't be read, so it can't connect. Run ${ctx.busCmd} add again.`,
      );
      return 1;
    }
    return pick(opts.name);
  }

  const shown = list.map((i) => {
    const canon = canonicalAddress(i.hub);
    return canon === undefined ? "(address unreadable)" : showAddress(canon);
  });
  if (shown.some((s) => s.length > SHOWN_MAX)) {
    sayErr(
      ctx,
      "Nothing changed: an address is too long to show in full, so it is not offered.",
    );
    return 1;
  }
  say(ctx, `Which instance should ${clean(key)} use?`, "");
  // A suggestion that changed after the folder was settled is marked too, so
  // the person sees which line the repo now points at; it is still only a mark.
  const marked =
    added ??
    (suggestion !== undefined && f.no[key] !== suggestion
      ? instanceAt(suggestion, list)
      : undefined);
  list.forEach((i, n) => {
    const mark =
      marked && i.name === marked.name ? "  (suggested by this repo)" : "";
    say(ctx, `  ${n + 1}. ${i.name}  ${shown[n]}${mark}`);
  });
  say(ctx, "");
  const answer = (
    await (ctx.readLine?.("Number, or Enter to change nothing: ") ??
      Promise.resolve(""))
  ).trim();
  if (answer === "") {
    say(ctx, "Nothing changed.");
    return 0;
  }
  const chosen = /^\d{1,3}$/.test(answer)
    ? list[Number(answer) - 1]
    : undefined;
  if (!chosen) {
    sayErr(ctx, "That is not on the list. Nothing changed.");
    return 1;
  }
  if (canonicalAddress(chosen.hub) === undefined) {
    sayErr(
      ctx,
      `Nothing changed: the address of ${chosen.name} can't be read, so it can't connect. Run ${ctx.busCmd} add again.`,
    );
    return 1;
  }
  return pick(chosen.name);
}
