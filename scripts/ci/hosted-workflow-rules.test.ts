// Hosted workflow rules. Split out of scripts/check-ci.test.ts (#1056): these
// read hosted workflows and files, so they live and run with the hosted paths.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

// W9b (design 10.1): install writes are the Provisioning API's. The
// hosted-ops workflow, the CLI's write commands and the laptop red-line
// scripts stay gone, and no workflow names their secrets again.
describe("W9b: the retired hosted writes stay retired", () => {
  const RETIRED_FILES = [
    ".github/workflows/hosted-ops.yml",
    "scripts/ci/hosted-ops-workflow.test.ts",
    "scripts/ci/hosted-turnstile-keys.sh",
    "scripts/hosted/src/ci-args.ts",
    "scripts/hosted/src/redline-creds.ts",
    "scripts/ops/redline-deploy.sh",
    "tests/redline/src/prod-clean-cli.ts",
  ];
  const workflows = readdirSync(join(root, ".github/workflows")).filter((f) =>
    /\.ya?ml$/.test(f),
  );

  it("the retired files do not exist", () => {
    for (const f of RETIRED_FILES)
      expect(existsSync(join(root, f)), f).toBe(false);
  });

  it("no workflow names a retired file, target or secret", () => {
    const banned =
      /hosted-ops|ci-args|redline-creds|redline-deploy|hosted-turnstile-keys|prod-clean-cli|inventory-key|INVENTORY_KEY|secrets\.REDLINE_RL_|CREATE_OWNER_EMAIL|TURNSTILE_KEYS/;
    // The one allowed match: R26's own API path (ROUTES.R26), called by the
    // test member's workflow through the Provisioning API, not the retired
    // CLI command. Only that exact quoted path in that one file.
    const R26_PATH = '"/v1/installs/$id/redline-creds"';
    for (const f of workflows) {
      const text = read(`.github/workflows/${f}`);
      expect(
        f === "staging-test-member.yml"
          ? text.split(R26_PATH).join('"R26"')
          : text,
        f,
      ).not.toMatch(banned);
    }
    expect(read(".github/workflows/staging-test-member.yml")).toContain(
      R26_PATH,
    );
  });

  // The CLI's own command lists are checked in scripts/hosted/test/cli.test.ts,
  // which moves with the CLI to the hosted repo (#1056).

  it("every oa:hosted call in a workflow is a kept command", () => {
    for (const f of workflows)
      for (const [, cmd] of read(`.github/workflows/${f}`).matchAll(
        /oa:hosted\s+(?:"\$\{[^}]*\}"|([a-z-]+))/g,
      ))
        expect(
          ["status", "publish-release", "publish-floor"],
          `${f}: ${cmd}`,
        ).toContain(cmd ?? "(argv)");
  });
});
