import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const setup = read("../src/content/docs/setup.md");
const upgrade = read("../src/content/docs/upgrade.md");
const connect = read("../src/content/docs/connect-agents.md");

describe("install runbook (#11-#14, #17)", () => {
  it("#11: whoami first, with a long timeout, skipping the login when accounts exist", () => {
    expect(setup).toContain(
      "First run `npx wrangler whoami --json` with at least a 3-minute timeout (it can refresh a login). If it lists accounts, skip the login.",
    );
  });
  it("#12: team asks about Workers Paid together and warns about the Access token and mail domain", () => {
    expect(setup).toContain(
      "in the same message, ask whether the account is on Workers Paid, and pass `--yes-paid` if so (invite email needs it)",
    );
    expect(setup).toMatch(
      /create a Cloudflare Access token and onboard the sending domain `mail\.<app-host>`/,
    );
  });
  it("#13: one hostname proposes the content host and owner email", () => {
    expect(setup).toContain("`<first-label>-content.<zone>`");
    expect(setup).toMatch(
      /email from `wrangler whoami` as `--owner-email`, and confirm both/,
    );
  });
  it("#14: clone outside any repo into ~/open-artifacts; upgrades run from there", () => {
    expect(setup).toContain(
      "Clone outside any existing git repository (the command uses `~/open-artifacts`), and tell the user the path: upgrades run from there.",
    );
    expect(setup).toContain('"$REPO" ~/open-artifacts');
    expect(upgrade).toContain("~/open-artifacts");
  });
  it("#17: the ignored build scripts message is documented as expected", () => {
    expect(setup).toContain(
      `pnpm may print "Ignored build scripts: esbuild, workerd". That's expected, so don't run \`pnpm approve-builds\`.`,
    );
  });
  it("#1873: the install directory is found from its state, not assumed", () => {
    expect(upgrade).toContain(".openartifacts/state.json");
    expect(upgrade).toContain("ask the user which directory they cloned into");
    expect(upgrade).toContain(
      "don't clone a second copy while the first exists",
    );
    // setup still names the default path, and says it can be elsewhere.
    expect(setup).toContain(
      "If the user asks for another path, use it and keep it: upgrades and any rollback run from that directory",
    );
  });
  it("#1872: the modules purge abort and the flag that answers it", () => {
    expect(upgrade).toContain("ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY");
    expect(upgrade).toContain(
      "pnpm install --frozen-lockfile --config.confirmModulesPurge=false",
    );
  });
  it("#1871: the bus client is a step, and the habits question is the user's", () => {
    expect(upgrade).toContain("**Offer the bus client.**");
    expect(upgrade).toContain(
      "npx @open-artifacts/bus install --instance https://<your-app-host>",
    );
    expect(upgrade).toContain("npx @open-artifacts/bus install --habits");
    expect(connect).toContain("## The bus client");
    expect(connect).toContain(
      "npx @open-artifacts/bus install --instance https://artifacts.example.com",
    );
  });
  it("no em dashes in the runbook copy", () => {
    expect(setup + upgrade).not.toContain("—");
  });
});
