// The access step when "access" isn't in AUTH_PROVIDERS (a Google-only
// install): done, not needed, with no Access API call at all. With access in
// AUTH_PROVIDERS (or unset, which means access), it behaves as before.
import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { ROOT, STATE } from "./fakes.ts";
import { HOSTS, world } from "./world.ts";

type W = ReturnType<typeof world>;
const access = (w: W) =>
  w.lines.map((l) => JSON.parse(l)).find((j) => j.step === "access");
const GOOGLE_ONLY = [
  ...["--auth-providers", "google"],
  ...["--auth-domains", "example.com"],
  ...["--google-client-id", "123-abc.apps.googleusercontent.com"],
];
/** Every Access API request (apps, policies, organizations) from here on. */
const accessCalls = (w: W) => {
  const seen: string[] = [];
  const inner = w.deps.fetch;
  w.deps.fetch = (input, init) => {
    const url = String(input);
    if (/\/access\//.test(url)) seen.push(`${init?.method ?? "GET"} ${url}`);
    return inner(input, init);
  };
  return seen;
};

/** Installed with Access, then switched to Google only and the Access app deleted (prod after the cutover). */
const cutOver = async () => {
  const w = world();
  expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
  expect(await run([...HOSTS, ...GOOGLE_ONLY], w.deps, ROOT)).toBe(0);
  w.apps.splice(0);
  // CI is stateless.
  w.files.delete(STATE);
  w.lines.length = 0;
  w.ops.length = 0;
  return w;
};

describe("access not in AUTH_PROVIDERS", () => {
  it("preflight (the live Worker is Google only, the app deleted): done, no Access call", async () => {
    const w = await cutOver();
    const calls = accessCalls(w);
    await run([...HOSTS, "--check", "--strict", "--upgrade"], w.deps, ROOT);
    expect(access(w).status).toBe("done");
    expect(access(w).message).toContain("not needed");
    expect(calls).toEqual([]);
    expect(w.ops.filter((o) => /polic|apps/i.test(o))).toEqual([]);
  });

  it("upgrade (Google only, the app deleted): never creates or requires an Access app", async () => {
    const w = await cutOver();
    const calls = accessCalls(w);
    await run([...HOSTS, "--upgrade"], w.deps, ROOT);
    expect(["ok", "skipped"]).toContain(access(w).status);
    expect(calls).toEqual([]);
    expect(w.apps).toEqual([]);
  });

  it("a fresh Google-only install creates no Access app", async () => {
    const w = world();
    const calls = accessCalls(w);
    await run([...HOSTS, ...GOOGLE_ONLY], w.deps, ROOT);
    expect(["ok", "skipped"]).toContain(access(w).status);
    expect(calls).toEqual([]);
    expect(w.apps).toEqual([]);
  });
});

describe("access in AUTH_PROVIDERS: as before", () => {
  it("the app deleted: preflight reports it not found", async () => {
    const w = world();
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    w.apps.splice(0);
    w.files.delete(STATE);
    w.lines.length = 0;
    const calls = accessCalls(w);
    await run([...HOSTS, "--check", "--strict", "--upgrade"], w.deps, ROOT);
    expect(access(w).status).toBe("todo");
    expect(access(w).message).toContain("Access app open-artifacts not found");
    expect(calls.length).toBeGreaterThan(0);
  });

  it("access,google on the live Worker: still verified against Access", async () => {
    const w = world();
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
    expect(
      await run(
        [
          ...HOSTS,
          ...["--auth-providers", "access,google"],
          ...GOOGLE_ONLY.slice(2),
        ],
        w.deps,
        ROOT,
      ),
    ).toBe(0);
    w.files.delete(STATE);
    w.lines.length = 0;
    const calls = accessCalls(w);
    await run([...HOSTS, "--check", "--strict", "--upgrade"], w.deps, ROOT);
    expect(access(w).status).toBe("done");
    expect(access(w).message).not.toContain("not needed");
    expect(calls.length).toBeGreaterThan(0);
  });
});
