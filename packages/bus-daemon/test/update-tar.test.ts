import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readTarball, unpackTo } from "../src/update/tar.ts";
import { golden, makeTgz, type RawEntry } from "./update-helpers.ts";

const file = (
  name: string,
  data = "x",
  more: Partial<RawEntry> = {},
): RawEntry => ({ name, data, ...more });
const refuses = (tgz: Buffer) =>
  expect(() => readTarball(tgz)).toThrow(/bad_tar/);

describe("update tar reader", () => {
  it("reads the real release", () => {
    const entries = readTarball(golden().tarball);
    expect(entries.map((e) => e.path)).toContain("package/dist/index.js");
    expect(entries.every((e) => e.type === "file")).toBe(true);
  });

  it("unpacks files 0600, dirs 0700, with no .live", () => {
    const dest = mkdtempSync(join(tmpdir(), "oa-tar-"));
    unpackTo(readTarball(golden().tarball), dest);
    expect(existsSync(join(dest, "package.json"))).toBe(true);
    expect(lstatSync(join(dest, "dist/index.js")).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(dest, "dist")).mode & 0o077).toBe(0);
    expect(
      readdirSync(dest, { recursive: true }).some((p) =>
        String(p).includes(".live"),
      ),
    ).toBe(false);
  });

  it.each([
    ["zip-slip", file("package/../evil.js")],
    ["zip-slip in dist", file("package/dist/../../evil.js")],
    ["absolute", file("/etc/passwd")],
    ["outside package/", file("other/dist/x.js")],
    ["not allowlisted", file("package/scripts/postinstall.js")],
    ["root file", file("package/README.md")],
    ["backslash", file("package/dist/a\\b.js")],
    ["NUL in the middle", file("package/dist/a\0b.js")],
    ["dot segment", file("package/dist/./a.js")],
    ["empty segment", file("package/dist//a.js")],
    ["reserved .live", file("package/dist/.live/x")],
    ["symlink", { name: "package/dist/l", type: "2", data: "" }],
    ["hardlink", { name: "package/dist/h", type: "1", data: "" }],
    ["char device", { name: "package/dist/c", type: "3", data: "" }],
    ["fifo", { name: "package/dist/f", type: "6", data: "" }],
    ["pax header", { name: "package/dist/p", type: "x", data: "" }],
    ["gnu long name", { name: "package/dist/L", type: "L", data: "" }],
  ] as [string, RawEntry][])("refuses %s", (_n, entry) => {
    refuses(makeTgz([file("package/package.json"), entry]));
  });

  it("refuses a name hidden in the ustar prefix", () => {
    refuses(makeTgz([file("a.js", "x", { prefix: "package/../.." })]));
  });

  it("refuses duplicates, case collisions and file-as-directory", () => {
    refuses(makeTgz([file("package/dist/a.js"), file("package/dist/a.js")]));
    refuses(makeTgz([file("package/dist/a.js"), file("package/dist/A.js")]));
    refuses(makeTgz([file("package/dist/a"), file("package/dist/a/b.js")]));
  });

  it("refuses a giant file and a tarbomb", () => {
    refuses(
      makeTgz([
        { name: "package/dist/big.js", data: "", size: 200 * 1024 * 1024 },
      ]),
    );
    const many = Array.from({ length: 2100 }, (_, i) =>
      file(`package/dist/f${i}.js`, ""),
    );
    refuses(makeTgz(many));
    const huge = gzipSync(Buffer.alloc(150 * 1024 * 1024));
    refuses(huge);
  });

  it("refuses garbage, a bad checksum, truncation, missing end and trailing data", () => {
    refuses(gzipSync(Buffer.from("not a tar".repeat(100))));
    refuses(Buffer.from("not gzip"));
    const ok = makeTgz([file("package/package.json")]);
    const raw = readTarball(ok);
    expect(raw).toHaveLength(1);
    refuses(makeTgz([file("package/package.json")], { noEnd: true }));
    refuses(
      makeTgz([file("package/package.json")], { trailer: Buffer.from("junk") }),
    );
    // flip a header byte: checksum no longer matches
    const tar = Buffer.from(makeTgz([file("package/package.json")]));
    refuses(
      Buffer.concat([
        tar.subarray(0, 20),
        Buffer.from([tar[20]! ^ 1]),
        tar.subarray(21),
      ]),
    );
  });

  it("will not write through a symlink planted in the destination", () => {
    const dest = mkdtempSync(join(tmpdir(), "oa-tar-"));
    const outside = mkdtempSync(join(tmpdir(), "oa-out-"));
    symlinkSync(outside, join(dest, "dist"));
    const entries = readTarball(makeTgz([file("package/dist/a.js", "x")]));
    expect(() => unpackTo(entries, dest)).toThrow();
    expect(readdirSync(outside)).toEqual([]);
  });

  it("refuses to overwrite an existing file (O_EXCL)", () => {
    const dest = mkdtempSync(join(tmpdir(), "oa-tar-"));
    const entries = readTarball(makeTgz([file("package/package.json", "{}")]));
    unpackTo(entries, dest);
    expect(() => unpackTo(entries, dest)).toThrow();
    expect(readFileSync(join(dest, "package.json"), "utf8")).toBe("{}");
  });
});
