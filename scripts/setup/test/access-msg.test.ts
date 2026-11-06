import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { ROOT } from "./fakes.ts";
import { HOSTS, world } from "./world.ts";

type W = ReturnType<typeof world>;
const line = (w: W, s: string) =>
  w.lines.map((l) => JSON.parse(l)).find((j) => j.step === s);
const md = readFileSync(
  join(import.meta.dirname, "../../../apps/landing/src/content/docs/setup.md"),
  "utf8",
);

describe("#3: the Access token reaches setup without a shared shell", () => {
  it("#3: setup reads ~/.open-artifacts/<name>-access-token when the env var is unset", async () => {
    const w = world({ org: "forbidden", env: { HOME: "/home/test" } });
    w.files.set(
      "/home/test/.open-artifacts/open-artifacts-access-token",
      "tok",
    );
    expect(await run(HOSTS, w.deps, ROOT)).toBe(0);
  });

  it("#3: the action_required message never asks the user to export a variable; it gives the save line, then rerun", async () => {
    const w = world({ org: "forbidden" });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(2);
    const m = line(w, "access").message as string;
    expect(m).not.toMatch(
      /export OA_ACCESS_TOKEN|read -rs OA_ACCESS_TOKEN|in the shell that launches/,
    );
    expect(m).toContain("pnpm --reporter=silent oa:setup --token-links --json");
    expect(m).toContain("saveCommand");
    expect(m).toMatch(/then rerun/);
  });

  it("#3: setup.md says the save line works in bash and zsh and that setup never deletes the file", () => {
    expect(md).toContain("The line works in bash and zsh");
    expect(md).toContain("Setup never deletes the file");
    expect(md).not.toMatch(
      /export OA_ACCESS_TOKEN|in the shell that launches setup/,
    );
  });
});

describe("#4: a fresh install does not offer OA_TEAM_DOMAIN", () => {
  it("#4: no Access app and no readable organization: the exact fresh-install message", async () => {
    const w = world({ org: "forbidden" });
    expect(await run(HOSTS, w.deps, ROOT)).toBe(2);
    const l = line(w, "access");
    expect(l.status).toBe("action_required");
    expect(l.message).toBe(
      `A fresh install needs a Cloudflare Access token (Access: Apps and Policies: Edit, Access: Organizations: Read). Create it at ${l.data.url}, save it with the line from \`pnpm --reporter=silent oa:setup --token-links --json\` (saveCommand), then rerun.`,
    );
    expect(l.message).not.toContain("OA_TEAM_DOMAIN");
  });

  it("#4: an unreadable Access with no saved state does not mention OA_TEAM_DOMAIN either", async () => {
    const w = world({ org: "forbidden" });
    await run(HOSTS, w.deps, ROOT);
    expect(JSON.stringify(line(w, "access"))).not.toContain("OA_TEAM_DOMAIN");
  });
});
