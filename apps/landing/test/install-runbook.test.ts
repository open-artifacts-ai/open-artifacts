import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const setup = read("../src/content/docs/setup.md");
const upgrade = read("../src/content/docs/upgrade.md");

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
  it("no em dashes in the runbook copy", () => {
    expect(setup + upgrade).not.toContain("—");
  });
});

/** Lines of `text` that print a git remote or config raw (#1923). */
const remoteLeaks = (text: string) =>
  text
    .replace(/\\\r?\n\s*/g, " ")
    .split("\n")
    .filter(
      (l) =>
        /git\b[^\n]*?\bremote\s+(-\w*v|--verbose|show)\b/.test(l) ||
        /ls-remote|\.git\/config|remote\.origin/.test(l) ||
        /git\b[^\n]*?\bconfig\b/.test(l) ||
        (/remote\s+get-url/.test(l) &&
          !/get-url\s+\S+\s*\|\s*(sed -E|grep -qE) /.test(l)),
    );

const LEAKS = [
  "git remote -v",
  "git remote --verbose",
  "git remote show origin",
  "git -C . remote -v",
  "git remote get-url origin",
  "git ls-remote origin",
  "cat .git/config",
  "git config --get remote.origin.url",
  "git config -l",
  "git config --list --local",
  "git config --local --list",
  "git remote get-url origin \\\n  | cat",
  "git remote -v",
];
const SAFE = [
  "git remote get-url origin | sed -E 's#^(https?://)[^/]*@#\\1***@#'",
  "if git remote get-url origin | grep -qE '^https?://[^/]*@'; then echo x; fi",
];

describe("upgrade guide git remote (#1923)", () => {
  it("never prints a remote or git config raw", () => {
    expect(remoteLeaks(upgrade), remoteLeaks(upgrade).join("|")).toEqual([]);
    expect(upgrade).not.toContain("credential.helper");
    expect(upgrade).toContain("grep -qE '^https?://[^/]*@'");
  });
  it("the guard fails on each bypass and passes the redacted forms", () => {
    for (const l of LEAKS) expect(remoteLeaks(l), l).not.toEqual([]);
    for (const l of SAFE) expect(remoteLeaks(l), l).toEqual([]);
  });
});
