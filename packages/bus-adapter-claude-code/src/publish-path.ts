import { constants, realpathSync } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

/** Maximum file size (bytes) allowed when publishing from a local path. */
export const PUBLISH_FILE_MAX = 25 * 1024 * 1024;

/** Basename patterns (case-insensitive) treated as sensitive. */
export const SECRET_NAMES: readonly string[] = [
  ".env",
  ".env.*",
  ".envrc",
  ".netrc",
  "_netrc",
  ".npmrc",
  ".pypirc",
  ".pgpass",
  ".git-credentials",
  ".dockercfg",
  "credentials",
  "credentials.json",
  "credentials.*",
  "secrets.*",
  "secret.*",
  ".dev.vars",
  ".dev.vars.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.jks",
  "*.keystore",
  "*.kdbx",
  "*.ovpn",
  "id_rsa*",
  "id_dsa*",
  "id_ecdsa*",
  "id_ed25519*",
  "*.tfstate",
  "*.tfstate.*",
  ".claude.json",
  "auth.json",
  "token",
  "*.token",
];

/** Directory segments (case-insensitive; slash-separated for adjacent pairs) treated as sensitive. */
export const SECRET_DIRS: readonly string[] = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".git",
  ".oa-bus",
  ".config/gcloud",
  ".password-store",
];

/** Result of validating a candidate file path for publishing. */
export type PathCheck =
  | {
      ok: true;
      real: string;
      inside: boolean;
      size: number;
      dev: number;
      ino: number;
    }
  | {
      ok: false;
      code: "not_found" | "not_file" | "too_large" | "secret" | "bad_path";
      message: string;
    };

const ENV_ALLOWED = new Set([".env.example", ".env.sample", ".env.template"]);

const HOME_SECRET_PATHS = new Set([
  ".claude/.credentials.json",
  ".codex/auth.json",
  ".pi/agent/auth.json",
]);

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`, "i");
}

const SECRET_NAME_PATTERNS: readonly RegExp[] = SECRET_NAMES.map(globToRegex);

const SECRET_DIR_SEGMENTS: readonly (readonly string[])[] = SECRET_DIRS.map(
  (entry) => entry.toLowerCase().split("/").filter(Boolean),
);

function toPosixPath(p: string): string {
  return p.replaceAll("\\", "/");
}

function homeRelativePaths(normalizedPath: string): string[] {
  const homes = new Set<string>();
  const rawHome = homedir();
  if (rawHome) {
    homes.add(toPosixPath(rawHome).replace(/\/+$/, ""));
    try {
      homes.add(toPosixPath(realpathSync(rawHome)).replace(/\/+$/, ""));
    } catch {
      // Ignore if homedir cannot be realpath'd.
    }
  }
  const lowerPath = normalizedPath.toLowerCase();
  const rels: string[] = [];
  for (const h of homes) {
    const prefix = `${h.toLowerCase()}/`;
    if (lowerPath.startsWith(prefix)) {
      rels.push(lowerPath.slice(prefix.length));
    }
  }
  return rels;
}

/** Returns true when any path segment, basename, or home-relative location matches a known secret. */
export function isSecretPath(realPath: string): boolean {
  const normalized = toPosixPath(realPath);
  const segments = normalized
    .split("/")
    .filter(Boolean)
    .map((s) => s.toLowerCase());

  if (segments.length === 0) return false;

  const base = basename(normalized).toLowerCase();
  if (!ENV_ALLOWED.has(base)) {
    for (const pattern of SECRET_NAME_PATTERNS) {
      if (pattern.test(base)) return true;
    }
  }

  for (const dirParts of SECRET_DIR_SEGMENTS) {
    if (dirParts.length === 1) {
      if (segments.includes(dirParts[0])) return true;
    } else if (dirParts.length > 1) {
      for (let i = 0; i <= segments.length - dirParts.length; i++) {
        let match = true;
        for (let j = 0; j < dirParts.length; j++) {
          if (segments[i + j] !== dirParts[j]) {
            match = false;
            break;
          }
        }
        if (match) return true;
      }
    }
  }

  for (const rel of homeRelativePaths(normalized)) {
    if (HOME_SECRET_PATHS.has(rel)) return true;
    if (
      rel.startsWith(".claude/") &&
      (base === "settings.json" ||
        base.startsWith("settings.") ||
        base.includes("credentials"))
    ) {
      return true;
    }
  }

  return false;
}

function expandPath(inputPath: string, root: string): string {
  if (inputPath.startsWith("~/")) {
    return resolve(join(homedir(), inputPath.slice(2)));
  }
  return resolve(root, inputPath);
}

/** Never throws. root = the session's working tree (absolute). */
export async function checkPublishPath(
  path: string,
  root: string,
): Promise<PathCheck> {
  if (typeof path !== "string" || path.length === 0) {
    return {
      ok: false,
      code: "bad_path",
      message: "Path must be a non-empty string",
    };
  }
  if (path.includes("\0")) {
    return {
      ok: false,
      code: "bad_path",
      message: "Path contains a NUL byte",
    };
  }
  if (typeof root !== "string" || root.length === 0 || root.includes("\0")) {
    return {
      ok: false,
      code: "bad_path",
      message: `Invalid root directory for path: ${path}`,
    };
  }

  const candidate = expandPath(path, root);

  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    realRoot = resolve(root);
  }

  let real: string;
  try {
    real = await realpath(candidate);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return {
        ok: false,
        code: "not_found",
        message: `File not found: ${path}`,
      };
    }
    return {
      ok: false,
      code: "bad_path",
      message: `Cannot resolve path: ${path}`,
    };
  }

  const rootPrefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`;
  const inside = real === realRoot || real.startsWith(rootPrefix);

  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(real);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return {
        ok: false,
        code: "not_found",
        message: `File not found: ${path}`,
      };
    }
    return {
      ok: false,
      code: "bad_path",
      message: `Cannot inspect path: ${path}`,
    };
  }

  if (!st.isFile()) {
    return {
      ok: false,
      code: "not_file",
      message: `Not a regular file: ${path}`,
    };
  }

  if (st.size > PUBLISH_FILE_MAX) {
    return {
      ok: false,
      code: "too_large",
      message: `File exceeds the ${PUBLISH_FILE_MAX} byte limit: ${path}`,
    };
  }

  if (isSecretPath(real) || isSecretPath(candidate)) {
    return {
      ok: false,
      code: "secret",
      message: `Refusing to publish sensitive path: ${path}`,
    };
  }

  return {
    ok: true,
    real,
    inside,
    size: st.size,
    dev: st.dev,
    ino: st.ino,
  };
}

/** Reads the file checked above; re-checks it is the same file (dev+ino) and still under the cap. Never follows a swapped symlink. */
export async function readPublishFile(
  check: Extract<PathCheck, { ok: true }>,
): Promise<
  | { ok: true; bytes: Buffer }
  | { ok: false; code: "changed" | "too_large" | "not_found"; message: string }
> {
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(check.real, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return {
        ok: false,
        code: "not_found",
        message: `File not found: ${check.real}`,
      };
    }
    return {
      ok: false,
      code: "changed",
      message: `File changed before reading: ${check.real}`,
    };
  }

  try {
    const st = await fh.stat();
    if (!st.isFile() || st.dev !== check.dev || st.ino !== check.ino) {
      return {
        ok: false,
        code: "changed",
        message: `File changed before reading: ${check.real}`,
      };
    }
    if (st.size > PUBLISH_FILE_MAX) {
      return {
        ok: false,
        code: "too_large",
        message: `File exceeds the ${PUBLISH_FILE_MAX} byte limit: ${check.real}`,
      };
    }
    const bytes = await fh.readFile();
    if (bytes.length > PUBLISH_FILE_MAX) {
      return {
        ok: false,
        code: "too_large",
        message: `File exceeds the ${PUBLISH_FILE_MAX} byte limit: ${check.real}`,
      };
    }
    return { ok: true, bytes };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return {
        ok: false,
        code: "not_found",
        message: `File not found: ${check.real}`,
      };
    }
    return {
      ok: false,
      code: "changed",
      message: `File changed before reading: ${check.real}`,
    };
  } finally {
    await fh.close();
  }
}
