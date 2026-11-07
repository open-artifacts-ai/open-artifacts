// #1628: the upgrade notice's rules and prompts, with a pinned clock. The
// banner itself comes later; these are the rules it will read.

import type { InstanceUpdate } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { upgradePrompt } from "../src/layout/update";
import {
  type DismissStore,
  dismissNotice,
  REMIND_MS,
  STALE_AFTER_MS,
  upgradeNotice,
} from "../src/layout/upgradeNotice";

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const UPDATE: InstanceUpdate = {
  latestVersion: "0.15.0",
  current: "0.14.2",
  custom: false,
  updateAvailable: true,
  breaking: false,
  notesUrl: "https://example.test/notes",
  checkedAt: ago(5 * 60_000),
  latestPublishedAt: ago(2 * DAY),
};
const u = (over: Partial<InstanceUpdate>): InstanceUpdate => ({
  ...UPDATE,
  ...over,
});

const memory = (): DismissStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
};
const notice = (update: InstanceUpdate | null, store = memory(), now = NOW) =>
  upgradeNotice(update, now, store);

describe("upgradePrompt", () => {
  const H = "https://a.example";
  it("without the update: the short form", () => {
    expect(upgradePrompt(H)).toBe(
      `Upgrade my Open Artifacts instance at ${H}. Follow ${H}/upgrade.md`,
    );
  });
  it("normal: both versions", () => {
    expect(upgradePrompt(H, UPDATE)).toBe(
      `Upgrade my Open Artifacts instance at ${H} from v0.14.2 to v0.15.0. Follow ${H}/upgrade.md`,
    );
  });
  it("breaking: asks for a yes first", () => {
    expect(upgradePrompt(H, u({ breaking: true }))).toBe(
      `Upgrade my Open Artifacts instance at ${H} from v0.14.2 to v0.15.0. Follow ${H}/upgrade.md This release has breaking changes: tell me what they mean for my instance and wait for my yes before you start.`,
    );
  });
  it("custom: names the build and asks what gets replaced", () => {
    expect(
      upgradePrompt(
        H,
        u({
          custom: true,
          current: "0.14.0-dev+4f2a9c1",
          updateAvailable: false,
          breaking: null,
        }),
      ),
    ).toBe(
      `Upgrade my Open Artifacts instance at ${H} from v0.14.0-dev+4f2a9c1 to v0.15.0. Follow ${H}/upgrade.md This instance runs a custom build (0.14.0-dev+4f2a9c1): tell me what upgrading will replace before you start.`,
    );
  });
});

describe("upgradeNotice: who sees what", () => {
  it("hidden with no update, or when up to date", () => {
    expect(notice(null)).toEqual({ show: false });
    expect(notice(undefined as unknown as null)).toEqual({ show: false });
    expect(notice(u({ updateAvailable: false }))).toEqual({ show: false });
  });
  it("normal: shown, dismissed with the X", () => {
    expect(notice(UPDATE)).toEqual({
      show: true,
      variant: "normal",
      dismiss: "x",
    });
  });
  it("breaking: the breaking variant, and sticky", () => {
    expect(notice(u({ breaking: true }))).toEqual({
      show: true,
      variant: "breaking",
      dismiss: "remind",
    });
  });
  it("unknown breaking (null) is a normal notice", () => {
    expect(notice(u({ breaking: null })).show).toBe(true);
    expect(notice(u({ breaking: null }))).toMatchObject({ variant: "normal" });
  });
});

describe("upgradeNotice: custom builds", () => {
  const custom = (current: string, latestVersion = "0.15.0") =>
    u({
      custom: true,
      current,
      latestVersion,
      updateAvailable: false,
      breaking: null,
    });
  it.each([
    ["0.14.0-dev+4f2a9c1", true],
    ["0.14.9-dev", true],
    ["0.9.0-rc.1", true],
    ["0.15.0-dev+4f2a9c1", false],
    ["0.15.0-dev", false],
    ["0.16.0-dev", false],
    ["1.0.0-dev", false],
  ])("custom %s behind 0.15.0 -> shown %s", (current, shown) => {
    expect(notice(custom(current)).show).toBe(shown);
  });
  it("compares numerically, not as text", () => {
    expect(notice(custom("0.9.0-dev", "0.10.0")).show).toBe(true);
    expect(notice(custom("0.10.0-dev", "0.9.0")).show).toBe(false);
  });
  it("uses the custom variant; unparseable builds stay quiet", () => {
    expect(notice(custom("0.14.0-dev"))).toEqual({
      show: true,
      variant: "custom",
      dismiss: "x",
    });
    expect(notice(custom("main"))).toEqual({ show: false });
  });
});

describe("upgradeNotice: per-version X", () => {
  it("an X hides that version only; a newer release brings it back", () => {
    const store = memory();
    dismissNotice(UPDATE, "x", NOW, store);
    expect(notice(UPDATE, store)).toEqual({ show: false });
    expect(notice(u({ latestVersion: "0.15.1" }), store).show).toBe(true);
  });
  it("an X is for good: still hidden weeks later", () => {
    const store = memory();
    dismissNotice(UPDATE, "x", NOW, store);
    expect(notice(UPDATE, store, NOW + 10 * DAY).show).toBe(false);
  });
});

describe("upgradeNotice: sticky", () => {
  it("a release older than 14 days is sticky; exactly 14 is not", () => {
    const at = (age: number) => u({ latestPublishedAt: ago(age) });
    expect(notice(at(STALE_AFTER_MS + 1))).toMatchObject({ dismiss: "remind" });
    expect(notice(at(STALE_AFTER_MS))).toMatchObject({ dismiss: "x" });
  });
  it("unknown or bad dates are not sticky", () => {
    expect(notice(u({ latestPublishedAt: null }))).toMatchObject({
      dismiss: "x",
    });
    expect(notice(u({ latestPublishedAt: undefined }))).toMatchObject({
      dismiss: "x",
    });
    expect(notice(u({ latestPublishedAt: "garbage" }))).toMatchObject({
      dismiss: "x",
    });
  });
  it("a custom build follows the same age rule", () => {
    const c = u({
      custom: true,
      current: "0.14.0-dev",
      updateAvailable: false,
      breaking: null,
      latestPublishedAt: ago(20 * DAY),
    });
    expect(notice(c)).toMatchObject({ variant: "custom", dismiss: "remind" });
  });
  it("an earlier X doesn't hide a notice that has since become sticky", () => {
    const store = memory();
    dismissNotice(UPDATE, "x", NOW - 6 * DAY, store);
    const later = u({ latestPublishedAt: ago(8 * DAY) });
    expect(upgradeNotice(later, NOW + 8 * DAY, store)).toMatchObject({
      show: true,
      dismiss: "remind",
    });
  });
});

describe("upgradeNotice: remind me tomorrow (24 h)", () => {
  const sticky = u({ breaking: true });
  it("hides for 24 hours, then comes back", () => {
    const store = memory();
    dismissNotice(sticky, "remind", NOW, store);
    expect(upgradeNotice(sticky, NOW + 1, store).show).toBe(false);
    expect(upgradeNotice(sticky, NOW + REMIND_MS - 1, store).show).toBe(false);
    expect(upgradeNotice(sticky, NOW + REMIND_MS, store).show).toBe(true);
  });
  it("is per version: a newer release shows at once", () => {
    const store = memory();
    dismissNotice(sticky, "remind", NOW, store);
    expect(
      upgradeNotice(u({ breaking: true, latestVersion: "0.15.1" }), NOW, store)
        .show,
    ).toBe(true);
  });
  it("a reminder more than a day ahead isn't honored", () => {
    const store = memory();
    store.setItem("oa.upgrade.remind.0.15.0", String(NOW + 10 * DAY));
    expect(upgradeNotice(sticky, NOW, store).show).toBe(true);
  });
  it("a store that refuses writes still hides it for the session", () => {
    const store: DismissStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    const other = u({ breaking: true, latestVersion: "9.9.9" });
    dismissNotice(other, "remind", NOW, store);
    expect(upgradeNotice(other, NOW + 1, store).show).toBe(false);
    const x = u({ latestVersion: "9.9.8" });
    dismissNotice(x, "x", NOW, store);
    expect(upgradeNotice(x, NOW, store).show).toBe(false);
  });
  it("a junk stored value doesn't hide it", () => {
    const store = memory();
    store.setItem("oa.upgrade.remind.0.15.0", "soon");
    expect(upgradeNotice(sticky, NOW, store).show).toBe(true);
  });
});
