import { execFileSync } from "node:child_process";
import {
  appendFile,
  link,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkPublishPath,
  isSecretPath,
  PUBLISH_FILE_MAX,
  readPublishFile,
} from "../src/publish-path.ts";

const tempDirs: string[] = [];

async function makeTempDir(prefix = "oa-publish-path-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("checkPublishPath", () => {
  it("accepts an absolute file inside root", async () => {
    const root = await makeTempDir();
    const file = join(root, "report.md");
    await writeFile(file, "hello");

    const res = await checkPublishPath(file, root);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.inside).toBe(true);
      expect(res.real).toBe(await realpath(file));
      expect(res.size).toBe(5);
    }
  });

  it("accepts a relative path inside root", async () => {
    const root = await makeTempDir();
    await mkdir(join(root, "docs"));
    const file = join(root, "docs", "notes.txt");
    await writeFile(file, "notes");

    const res = await checkPublishPath("docs/notes.txt", root);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.inside).toBe(true);
      expect(res.real).toBe(await realpath(file));
    }
  });

  it("marks ../ escape outside root", async () => {
    const base = await makeTempDir();
    const root = join(base, "work");
    await mkdir(root);
    const outside = join(base, "outside.txt");
    await writeFile(outside, "out");

    const res = await checkPublishPath("../outside.txt", root);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.inside).toBe(false);
    }
  });

  it("marks sibling prefix directory (/x/ab vs /x/a) outside root", async () => {
    const base = await makeTempDir();
    const root = join(base, "a");
    const sibling = join(base, "ab");
    await mkdir(root);
    await mkdir(sibling);
    const siblingFile = join(sibling, "file.txt");
    await writeFile(siblingFile, "sib");

    const res = await checkPublishPath(siblingFile, root);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.inside).toBe(false);
    }
  });

  it("marks a symlink inside root pointing outside as outside", async () => {
    const base = await makeTempDir();
    const root = join(base, "root");
    const outsideDir = join(base, "outside");
    await mkdir(root);
    await mkdir(outsideDir);
    const target = join(outsideDir, "data.txt");
    await writeFile(target, "outside data");
    const link = join(root, "link.txt");
    await symlink(target, link);

    const res = await checkPublishPath(link, root);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.inside).toBe(false);
      expect(res.real).toBe(await realpath(target));
    }
  });

  it("refuses a symlink to a .env file as secret", async () => {
    const root = await makeTempDir();
    const secret = join(root, ".env");
    await writeFile(secret, "SECRET=1");
    const link = join(root, "harmless.txt");
    await symlink(secret, link);

    const res = await checkPublishPath(link, root);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("secret");
      expect(res.message).toContain(link);
    }
  });

  it("refuses a secret-named symlink to a harmless file as secret", async () => {
    const root = await makeTempDir();
    const harmless = join(root, "harmless.txt");
    await writeFile(harmless, "plain");
    const link = join(root, ".env");
    await symlink(harmless, link);

    const res = await checkPublishPath(link, root);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("secret");
    }
  });

  it.each([
    ".env",
    ".env.local",
    "id_ed25519",
    "x.pem",
    ".ssh/config",
    ".git/config",
    ".config/gcloud/credentials.db",
  ])("refuses %s as secret", async (relPath) => {
    const root = await makeTempDir();
    const full = join(root, relPath);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, "sensitive");

    const res = await checkPublishPath(relPath, root);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("secret");
      expect(res.message).toContain(relPath);
    }
  });

  it.each([".env.example", ".env.sample", ".env.template"])(
    "allows %s",
    async (relPath) => {
      const root = await makeTempDir();
      const full = join(root, relPath);
      await writeFile(full, "KEY=placeholder");

      const res = await checkPublishPath(relPath, root);
      expect(res.ok).toBe(true);
    },
  );

  it("refuses a directory as not_file", async () => {
    const root = await makeTempDir();
    const dir = join(root, "subdir");
    await mkdir(dir);

    const res = await checkPublishPath(dir, root);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("not_file");
    }
  });

  it("refuses a file with another hard link", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "a.html"), "x");
    await link(join(root, "a.html"), join(root, "b.html"));
    const r = await checkPublishPath("b.html", root);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("linked");
  });

  it("refuses a harmless name routed through a secret-named symlink", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "notes.txt"), "x");
    await symlink(join(root, "notes.txt"), join(root, ".env"));
    await symlink(join(root, ".env"), join(root, "page.html"));
    const r = await checkPublishPath("page.html", root);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("secret");
  });

  it("refuses a file under a secret-named folder", async () => {
    const root = await makeTempDir();
    await mkdir(join(root, ".env"));
    await writeFile(join(root, ".env", "page.html"), "x");
    const r = await checkPublishPath(".env/page.html", root);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("secret");
  });

  it("counts nothing as inside when the working folder is the filesystem root", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "a.html"), "x");
    const r = await checkPublishPath(join(root, "a.html"), "/");
    expect(r.ok && r.inside).toBe(false);
  });

  it("refuses when the working folder cannot be resolved", async () => {
    const root = await makeTempDir();
    const r = await checkPublishPath("a.html", join(root, "missing"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("bad_path");
  });

  it("refuses a missing file as not_found", async () => {
    const root = await makeTempDir();

    const res = await checkPublishPath("does-not-exist.txt", root);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("not_found");
    }
  });

  it("refuses a path containing a NUL byte as bad_path", async () => {
    const root = await makeTempDir();

    const res = await checkPublishPath("foo\0bar.txt", root);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("bad_path");
    }
  });

  it("refuses an empty path as bad_path", async () => {
    const root = await makeTempDir();

    const res = await checkPublishPath("", root);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("bad_path");
    }
  });

  it("refuses a file larger than PUBLISH_FILE_MAX as too_large", async () => {
    const root = await makeTempDir();
    const huge = join(root, "huge.bin");
    const fh = await open(huge, "w");
    try {
      await fh.truncate(PUBLISH_FILE_MAX + 1);
    } finally {
      await fh.close();
    }

    const res = await checkPublishPath(huge, root);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("too_large");
    }
  });
});

describe("isSecretPath", () => {
  it("flags home-relative agent credential and settings paths", () => {
    const home = homedir();
    expect(isSecretPath(join(home, ".claude", ".credentials.json"))).toBe(true);
    expect(isSecretPath(join(home, ".claude", "settings.json"))).toBe(true);
    expect(isSecretPath(join(home, ".codex", "auth.json"))).toBe(true);
    expect(isSecretPath(join(home, ".pi", "agent", "auth.json"))).toBe(true);
  });

  it("flags everything under the home harness and bus credential folders", () => {
    const home = homedir();
    expect(isSecretPath(join(home, ".claude", "notes.md"))).toBe(true);
    expect(isSecretPath(join(home, ".codex", "config.toml"))).toBe(true);
    expect(
      isSecretPath(join(home, ".open-artifacts", "laptop-pat-token")),
    ).toBe(true);
  });

  it("does not flag a project's own .claude folder", () => {
    expect(isSecretPath("/work/repo/.claude/agents/x.md")).toBe(false);
  });

  it("flags the extra secret names", () => {
    for (const n of [
      "AuthKey_X.p8",
      "service-account-prod.json",
      "staging-pat-token",
      ".htpasswd",
    ])
      expect(isSecretPath(`/work/${n}`), n).toBe(true);
    expect(isSecretPath("/work/page.html")).toBe(false);
  });

  it("does not flag non-adjacent .config and gcloud segments", () => {
    expect(isSecretPath("/tmp/work/.config/other/gcloud/notes.txt")).toBe(
      false,
    );
  });
});

describe("readPublishFile", () => {
  it("returns the file bytes for an unchanged checked file", async () => {
    const root = await makeTempDir();
    const file = join(root, "hello.txt");
    await writeFile(file, "hello world");

    const check = await checkPublishPath(file, root);
    expect(check.ok).toBe(true);
    if (!check.ok) return;

    const read = await readPublishFile(check);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.bytes.toString("utf8")).toBe("hello world");
    }
  });

  it("returns changed when the file is replaced by a different file", async () => {
    const root = await makeTempDir();
    const file = join(root, "swap.txt");
    await writeFile(file, "original");

    const check = await checkPublishPath(file, root);
    expect(check.ok).toBe(true);
    if (!check.ok) return;

    await unlink(file);
    await writeFile(file, "replacement");

    const read = await readPublishFile(check);
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.code).toBe("changed");
    }
  });

  it("returns changed when the file is replaced by a symlink", async () => {
    const root = await makeTempDir();
    const file = join(root, "swap.txt");
    const other = join(root, "other.txt");
    await writeFile(file, "original");
    await writeFile(other, "other");

    const check = await checkPublishPath(file, root);
    expect(check.ok).toBe(true);
    if (!check.ok) return;

    await unlink(file);
    await symlink(other, file);

    const read = await readPublishFile(check);
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.code).toBe("changed");
    }
  });

  it("returns changed, without hanging, when the file is swapped for a FIFO", async () => {
    const root = await makeTempDir();
    const file = join(root, "swap.txt");
    await writeFile(file, "original");
    const check = await checkPublishPath(file, root);
    if (!check.ok) throw new Error("check failed");
    await unlink(file);
    execFileSync("mkfifo", [file]);
    const read = await readPublishFile(check);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.code).toBe("changed");
  });

  it("reads a file that grew after the check, and refuses one grown past the cap", async () => {
    const root = await makeTempDir();
    const file = join(root, "grow.txt");
    await writeFile(file, "short");
    const check = await checkPublishPath(file, root);
    if (!check.ok) throw new Error("check failed");
    await appendFile(file, " and longer");
    const grown = await readPublishFile(check);
    expect(grown.ok && grown.bytes.toString()).toBe("short and longer");
    const fh = await open(file, "r+");
    await fh.truncate(PUBLISH_FILE_MAX + 1);
    await fh.close();
    const big = await readPublishFile(check);
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.code).toBe("too_large");
  });

  it("returns not_found when the file is removed before reading", async () => {
    const root = await makeTempDir();
    const file = join(root, "gone.txt");
    await writeFile(file, "bye");

    const check = await checkPublishPath(file, root);
    expect(check.ok).toBe(true);
    if (!check.ok) return;

    await unlink(file);

    const read = await readPublishFile(check);
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.code).toBe("not_found");
    }
  });
});
