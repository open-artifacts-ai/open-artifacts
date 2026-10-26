import {
  chmodSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkImport,
  importKeyOf,
  parseExport,
  problems,
  type Report,
  snapshot,
  type Target,
} from "../src/check.ts";
import { FakeInstall, type FakeUser } from "./fake.ts";
import { runSkill } from "./skill.ts";

const FIXTURE = join(import.meta.dirname, "../fixtures/synthetic-export");
const C1 = "11111111-1111-4111-8111-111111111111";
const C2 = "22222222-2222-4222-8222-222222222222";
const C3 = "33333333-3333-4333-8333-333333333333";
const C4 = "44444444-4444-4444-8444-444444444444";
const K = {
  planner: `claude:${C1}:watering-planner`,
  notes: `claude:${C2}:warehouse-notes`,
  widget: `claude:${C2}:shelf-widget`,
  big: `claude:${C2}:inventory-table`,
  greet: `claude:${C3}:greet-fn`,
  notes2: `claude:${C4}:warehouse-notes`,
};

let dir: string;
let fake: FakeInstall;
let alice: FakeUser;
let bob: FakeUser;
let eng: string;
let target: Target;
let spaceMap: Record<string, string>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oa-import-"));
  fake = new FakeInstall();
  alice = fake.addUser("alice@example.invalid");
  bob = fake.addUser("bob@example.invalid");
  eng = fake.addSpace("Engineering");
  fake.addSpace("Personal projects");
  const patFile = join(dir, "pat");
  writeFileSync(patFile, alice.token, { mode: 0o600 });
  target = { app: "https://fake.invalid", patFile, fetch: fake.fetch };
  // C1 and C2 go to Engineering (C2 by name), the rest to the personal space.
  spaceMap = { [C1]: eng, [C2]: "Engineering" };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const skill = (
  bugs?: Parameters<typeof runSkill>[1]["bugs"],
  exportDir = FIXTURE,
) =>
  runSkill(fake, {
    exportDir,
    ownerId: alice.id,
    spaceMap: { [C1]: eng, [C2]: eng },
    bugs,
  });
const check = async (
  before: Awaited<ReturnType<typeof snapshot>>,
  exportDir = FIXTURE,
) => checkImport({ target, exportDir, owner: alice.email, spaceMap, before });
const clean = (r: Report) => {
  expect(r.wrongSpace).toEqual([]);
  expect(r.wrongOwner).toEqual([]);
  expect(r.duplicates).toEqual([]);
  expect(r.extraVersions).toEqual([]);
  expect(r.unexpected).toEqual([]);
  expect(r.wrongContent).toEqual([]);
  expect(problems(r)).toEqual([]);
};

describe("parseExport", () => {
  it("reads every artifact once, keyed by source, conversation and artifact id", () => {
    const items = parseExport(FIXTURE);
    expect(items.map((i) => i.importKey).sort()).toEqual(
      Object.values(K).sort(),
    );
  });

  it("applies updates and rewrites in order (the re-edited artifact)", () => {
    const p = parseExport(FIXTURE).find((i) => i.importKey === K.planner);
    expect(p?.content).toContain("<td>Fern</td><td>Tuesday</td>");
    expect(p?.content).not.toContain("<ul>");
  });

  it("marks the unsupported type and keeps the very large one", () => {
    const items = parseExport(FIXTURE);
    expect(items.find((i) => i.importKey === K.widget)?.supported).toBe(false);
    const big = items.find((i) => i.importKey === K.big);
    expect(big?.supported).toBe(true);
    expect(Buffer.byteLength(big?.content ?? "")).toBeGreaterThan(128 * 1024);
  });
});

describe("checkImport", () => {
  it("a correct import reports zero problems", async () => {
    const before = await snapshot(target);
    skill();
    const r = await check(before);
    expect(r.expected).toBe(6);
    expect(r.imported).toBe(5);
    expect(r.skipped).toEqual([
      {
        ref: K.widget,
        reason: "unsupported type: application/vnd.ant.unsupported-widget",
      },
    ]);
    clean(r);
  });

  it("a second run with no new artifacts reports zero new artifacts and zero new versions", async () => {
    skill();
    const before = await snapshot(target);
    skill();
    const after = await snapshot(target);
    expect(after.artifacts.map((a) => [a.id, a.versions.length])).toEqual(
      before.artifacts.map((a) => [a.id, a.versions.length]),
    );
    const r = await check(before);
    expect(r.imported).toBe(5);
    clean(r);
  });

  it("an artifact published to the wrong space or with the wrong owner is reported", async () => {
    const before = await snapshot(target);
    skill({
      wrongSpace: { [K.notes]: alice.id },
      wrongOwner: { [K.planner]: bob.id },
    });
    const r = await check(before);
    expect(r.wrongSpace).toEqual([K.notes]);
    expect(r.wrongOwner).toEqual([K.planner]);
    expect(problems(r)).toHaveLength(2);
  });

  // The limit: the checker sees what the owner's PAT can list. A copy owned
  // by someone else in their private space is invisible: it shows only as
  // not imported, never as wrongOwner.
  it("wrongOwner covers only artifacts visible to the owner's PAT", async () => {
    const before = await snapshot(target);
    skill({
      wrongOwner: { [K.greet]: bob.id },
      wrongSpace: { [K.greet]: bob.id },
    });
    const r = await check(before);
    expect(fake.artifacts.some((a) => a.importKey === K.greet)).toBe(true);
    expect(r.wrongOwner).toEqual([]);
    expect(r.skipped).toContainEqual({ ref: K.greet, reason: "not imported" });
  });

  it("skipped items must carry a reason", async () => {
    const before = await snapshot(target);
    skill({ skip: [K.big] });
    const r = await check(before);
    expect(r.imported).toBe(4);
    for (const s of r.skipped) expect(s.reason.trim()).not.toBe("");
    // A supported item missing from the install is a problem...
    expect(r.skipped).toContainEqual({ ref: K.big, reason: "not imported" });
    // ...an unsupported one is skipped with its reason and isn't.
    expect(r.skipped).toContainEqual({
      ref: K.widget,
      reason: "unsupported type: application/vnd.ant.unsupported-widget",
    });
    expect(problems(r)).toEqual([`skipped ${K.big}: not imported`]);
  });

  it("new keyless artifacts are unexpected, by id", async () => {
    const before = await snapshot(target);
    skill();
    const ids = Array.from({ length: 5 }, (_, i) =>
      fake.create({
        ownerId: alice.id,
        spaceId: alice.id,
        importKey: null,
        files: { "index.html": `extra ${i}` },
      }),
    );
    const r = await check(before);
    expect(r.unexpected.sort()).toEqual(ids.sort());
    expect(problems(r)).toHaveLength(5);
  });

  it("new artifacts with malformed or unknown keys are unexpected", async () => {
    const before = await snapshot(target);
    skill();
    const bad = fake.create({
      ownerId: alice.id,
      spaceId: alice.id,
      importKey: "claude:no-artifact-id",
      files: { "index.html": "x" },
    });
    const unknown = `claude:${C1}:not-in-export`;
    fake.create({
      ownerId: alice.id,
      spaceId: alice.id,
      importKey: unknown,
      files: { "index.html": "y" },
    });
    const r = await check(before);
    expect(r.unexpected.sort()).toEqual([bad, unknown].sort());
  });

  it("a rerun that deletes and recreates an artifact under a new id is unexpected", async () => {
    skill();
    const before = await snapshot(target);
    const old = fake.artifacts.find((a) => a.importKey === K.notes);
    fake.remove(old?.id ?? "");
    skill();
    const r = await check(before);
    expect(r.duplicates).toEqual([]);
    expect(r.unexpected).toEqual([K.notes]);
  });

  it("a rerun adding a version with content plus a newline is extra and wrong content", async () => {
    skill();
    const before = await snapshot(target);
    const a = fake.artifacts.find((x) => x.importKey === K.notes);
    const files = a?.versions[0].files ?? {};
    fake.addVersion(a?.id ?? "", { "README.md": `${files["README.md"]}\n` });
    const r = await check(before);
    expect(r.extraVersions).toEqual([K.notes]);
    expect(r.wrongContent).toEqual([K.notes]);
  });

  it("a first import with emptied files is wrong content", async () => {
    const before = await snapshot(target);
    skill();
    const a = fake.artifacts.find((x) => x.importKey === K.planner);
    if (a) a.versions[0].files = { "index.html": "" };
    const r = await check(before);
    expect(r.wrongContent).toEqual([K.planner]);
    expect(r.extraVersions).toEqual([]);
  });

  it("a first import with two versions of distinct content is an extra version", async () => {
    const before = await snapshot(target);
    skill();
    const a = fake.artifacts.find((x) => x.importKey === K.greet);
    const files = a?.versions[0].files ?? {};
    if (a) {
      a.versions[0].files = { "index.html": "draft" };
      fake.addVersion(a.id, files);
    }
    const r = await check(before);
    expect(r.extraVersions).toEqual([K.greet]);
    expect(r.wrongContent).toEqual([]);
  });

  // Review Focus 5, pinned: a rerun must not duplicate.
  it("a rerun that creates duplicate artifacts is reported (duplicates)", async () => {
    skill();
    const before = await snapshot(target);
    skill({ duplicate: true });
    const r = await check(before);
    expect(r.duplicates.sort()).toEqual(
      [K.planner, K.notes, K.big, K.greet, K.notes2].sort(),
    );
    expect(r.extraVersions).toEqual([]);
    expect(problems(r).length).toBeGreaterThan(0);
  });

  it("a rerun that adds versions to unchanged artifacts is reported (extraVersions)", async () => {
    skill();
    const before = await snapshot(target);
    skill({ versionUnchanged: true });
    const r = await check(before);
    expect(r.extraVersions.sort()).toEqual(
      [K.planner, K.notes, K.big, K.greet, K.notes2].sort(),
    );
    expect(r.duplicates).toEqual([]);
    expect(problems(r).length).toBeGreaterThan(0);
  });

  it("a changed artifact adding exactly one version is not an extra version", async () => {
    skill();
    const before = await snapshot(target);
    const edited = editedExport();
    skill(undefined, edited);
    const r = await check(before, edited);
    expect(
      fake.artifacts.find((a) => a.importKey === K.notes)?.versions,
    ).toHaveLength(2);
    clean(r);
  });

  it("a changed artifact adding two versions is an extra version", async () => {
    skill();
    const before = await snapshot(target);
    const edited = editedExport();
    skill({ doubleVersion: true }, edited);
    const r = await check(before, edited);
    expect(r.extraVersions).toEqual([K.notes]);
  });

  it("a rerun adding two versions of distinct content to a changed artifact is extra", async () => {
    skill();
    const before = await snapshot(target);
    const edited = editedExport();
    const a = fake.artifacts.find((x) => x.importKey === K.notes);
    fake.addVersion(a?.id ?? "", { "README.md": "an interim draft\n" });
    skill(undefined, edited);
    expect(a?.versions).toHaveLength(3);
    const r = await check(before, edited);
    expect(r.extraVersions).toEqual([K.notes]);
    expect(r.wrongContent).toEqual([]);
  });

  it("a first run that publishes the same content twice is an extra version", async () => {
    const before = await snapshot(target);
    skill();
    const id = fake.artifacts.find((a) => a.importKey === K.big)?.id ?? "";
    fake.addVersion(id, fake.mustGet(id).versions[0].files);
    const r = await check(before);
    expect(r.extraVersions).toEqual([K.big]);
  });

  it("a key reused across conversations is two artifacts, not a duplicate", async () => {
    const before = await snapshot(target);
    skill();
    const r = await check(before);
    expect(
      fake.artifacts.filter((a) => a.importKey?.endsWith(":warehouse-notes")),
    ).toHaveLength(2);
    expect(r.duplicates).toEqual([]);
  });

  it("pages through artifacts, versions and spaces", async () => {
    fake.listPage = 1;
    fake.versionsPage = 1;
    skill();
    const before = await snapshot(target);
    skill({ versionUnchanged: true });
    const s = await snapshot(target);
    expect(s.artifacts).toHaveLength(5);
    expect(s.artifacts.every((a) => a.versions.length === 2)).toBe(true);
    expect(s.spaces.map((x) => x.name)).toEqual([
      "Engineering",
      "Personal projects",
    ]);
    expect((await check(before)).extraVersions).toHaveLength(5);
  });

  it("refuses a checker run with a PAT that isn't the owner's", async () => {
    const before = await snapshot(target);
    await expect(
      checkImport({
        target,
        exportDir: FIXTURE,
        owner: bob.email,
        spaceMap,
        before,
      }),
    ).rejects.toThrow(/owner's PAT/);
  });

  it("refuses a spaceMap value that names no visible space", async () => {
    const before = await snapshot(target);
    await expect(
      checkImport({
        target,
        exportDir: FIXTURE,
        owner: alice.email,
        spaceMap: { "*": "Nope" },
        before,
      }),
    ).rejects.toThrow(/spaceMap/);
  });
});

describe("safety", () => {
  it("a failure shows status and a body hash, never the body or the PAT", async () => {
    fake.failWith = { status: 500, body: "SECRET-BODY-123" };
    const err = await snapshot(target).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/status 500, body sha256:[0-9a-f]{16}/);
    expect(err?.message).not.toContain("SECRET-BODY-123");
    expect(err?.message).not.toContain(alice.token);
  });

  it("refuses a PAT file readable by group or others", async () => {
    chmodSync(target.patFile, 0o644);
    await expect(snapshot(target)).rejects.toThrow(/0600/);
  });

  it("refuses a PAT file not owned by the current user", async () => {
    const uid = vi.spyOn(process, "getuid").mockReturnValue(424242);
    try {
      await expect(snapshot(target)).rejects.toThrow(/not owned/);
    } finally {
      uid.mockRestore();
    }
  });

  it("refuses a before snapshot taken with another PAT", async () => {
    const bobPat = join(dir, "bob-pat");
    writeFileSync(bobPat, bob.token, { mode: 0o600 });
    const before = await snapshot({ ...target, patFile: bobPat });
    await expect(check(before)).rejects.toThrow(/different PATs/);
  });

  it("reads importKey only through importKeyOf", () => {
    expect(importKeyOf({ importKey: K.notes })).toBe(K.notes);
    expect(importKeyOf({ importKey: "other:x:y" })).toBeNull();
    expect(importKeyOf({})).toBeNull();
    expect(importKeyOf(null)).toBeNull();
  });

  it("an artifact with a malformed importKey is not counted as imported", async () => {
    const before = await snapshot(target);
    skill();
    const big = fake.artifacts.find((a) => a.importKey === K.big);
    if (big) big.importKey = "claude:bad";
    const r = await check(before);
    expect(r.imported).toBe(4);
    expect(r.skipped).toContainEqual({ ref: K.big, reason: "not imported" });
  });
});

/** A copy of the fixture with one artifact's content changed. */
function editedExport(): string {
  const out = join(dir, "edited");
  cpSync(FIXTURE, out, { recursive: true });
  const p = join(out, "conversations.json");
  writeFileSync(
    p,
    readFileSync(p, "utf8").replace("Shelves A to F", "Shelves A to G"),
  );
  return out;
}
