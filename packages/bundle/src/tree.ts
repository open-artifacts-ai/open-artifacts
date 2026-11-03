// The hardened build-output reader, moved from @oa/provision's release.ts
// (#1056) so the public release bundle builder needs nothing private.
import { constants, type Dirent, type Stats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";

export interface ReleaseAsset {
  path: string;
  bytes: Uint8Array;
}

/**
 * Refuses an asset path that is not plain relative segments of
 * [A-Za-z0-9._~@+-]: so no empty, absolute, backslash, "%", space or
 * non-ASCII segment, and no segment starting with "." (dotfiles,
 * dot-directories, "." and "..").
 */
export function assertAssetPath(path: unknown): asserts path is string {
  const ok =
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= 1024 &&
    path
      .split("/")
      .every((s) => /^[A-Za-z0-9._~@+-]+$/.test(s) && !s.startsWith("."));
  if (!ok)
    throw new Error(
      `asset path ${JSON.stringify(String(path)).slice(0, 80)} is not allowed (no dotfile, dot-directory, empty, absolute or backslash segment)`,
    );
}

const fileStamp = (st: Stats) => `f:${st.dev}:${st.ino}:${st.size}:${st.nlink}`;
const dirStamp = (st: Stats) => `d:${st.dev}:${st.ino}`;

/**
 * The one reader for every file of a build output (bundle outdir, assets,
 * template, migrations, welcome): regular files only, inside `dir`.
 * - realpath the root; refuse any entry whose realpath leaves it;
 * - open every file O_RDONLY|O_NOFOLLOW (and O_NONBLOCK, so a FIFO swapped
 *   in cannot hang) and take size, ino, dev and nlink from fstat on the
 *   handle; refuse anything not a regular file, and nlink > 1 (hardlink);
 * - record every directory (ino, dev) from a directory handle;
 * - walk again after reading and require the same files and directories
 *   with the same ino, dev and size.
 * `check` refuses a relative path (default assertAssetPath); `pick` keeps
 * only the entries it names (others are skipped, never opened, in both
 * walks: one file of a source directory); `afterRead` runs between the two
 * walks (tests).
 */
export async function readTreeHardened(
  dir: string,
  o: {
    check?: (rel: string) => void;
    pick?: (rel: string) => boolean;
    afterRead?: () => Promise<void>;
  } = {},
): Promise<ReleaseAsset[]> {
  const check = o.check ?? assertAssetPath;
  const root = await realpath(dir);
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW;
  const inside = async (p: string, rel: string) => {
    const r = await realpath(p);
    if (r !== root && !r.startsWith(root + sep))
      throw new Error(`${rel} resolves outside ${dir} (symlink)`);
  };
  const openNoFollow = async (p: string, rel: string, extra: number) => {
    try {
      return await open(p, flags | extra);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ELOOP" || code === "EMLINK")
        throw new Error(`${rel} is a symlink; refusing to follow it`);
      if (code === "ENOTDIR") throw new Error(`${rel} is not a directory`);
      throw err;
    }
  };
  const walk = async (read: boolean) => {
    const seen = new Map<string, string>();
    const out: ReleaseAsset[] = [];
    const visit = async (rel: string): Promise<void> => {
      const p = rel ? join(root, rel) : root;
      const dh = await openNoFollow(p, rel || ".", constants.O_DIRECTORY);
      let entries: Dirent[];
      try {
        const st = await dh.stat();
        if (!st.isDirectory()) throw new Error(`${rel} is not a directory`);
        await inside(p, rel || ".");
        entries = await readdir(p, { withFileTypes: true });
        // The directory listed is still the one held open.
        if (dirStamp(await lstat(p)) !== dirStamp(st))
          throw new Error(`${dir}: the tree changed while it was read`);
        seen.set(`${rel}/`, dirStamp(st));
      } finally {
        await dh.close();
      }
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (o.pick && !o.pick(r)) continue;
        check(r);
        if (e.isSymbolicLink())
          throw new Error(`${r} is a symlink; refusing to follow it`);
        if (e.isDirectory()) {
          await visit(r);
          continue;
        }
        if (!e.isFile()) throw new Error(`${r} is not a regular file`);
        // N4: opened by full path, so an intermediate directory swapped
        // after its listing is not seen here; the second walk's directory
        // and file stamps (dev, ino, size) are what catch it. Keep both walks.
        const q = join(root, r);
        const fh = await openNoFollow(q, r, constants.O_NONBLOCK);
        try {
          const st = await fh.stat();
          if (!st.isFile()) throw new Error(`${r} is not a regular file`);
          if (st.nlink > 1)
            throw new Error(
              `${r} has ${st.nlink} links (hardlink); refusing it`,
            );
          await inside(q, r);
          seen.set(r, fileStamp(st));
          if (read) {
            const bytes = new Uint8Array(await fh.readFile());
            if (bytes.byteLength !== st.size)
              throw new Error(`${dir}: the tree changed while it was read`);
            out.push({ path: r, bytes });
          }
        } finally {
          await fh.close();
        }
      }
    };
    await visit("");
    return { seen, out };
  };
  const first = await walk(true);
  await o.afterRead?.();
  const second = await walk(false);
  const same =
    first.seen.size === second.seen.size &&
    [...first.seen].every(([k, v]) => second.seen.get(k) === v);
  if (!same) throw new Error(`${dir}: the tree changed while it was read`);
  return first.out.sort((a, b) => (a.path < b.path ? -1 : 1));
}
