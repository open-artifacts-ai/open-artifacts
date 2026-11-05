// #1301: release-please.yml publishes @open-artifacts/bus to npm, with
// provenance, only for a stable release from a push to main. pack-npm runs
// the repository's code with no credentials; publish-npm holds the npm token
// (npm-publish Environment) and the OIDC token and runs no repository code.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { root, sandbox } from "./stubs.ts";

const raw = readFileSync(
  join(root, ".github/workflows/release-please.yml"),
  "utf8",
);
// biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
const jobs: any = parse(raw).jobs;
const pack = jobs["pack-npm"];
const pub = jobs["publish-npm"];
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
type Step = Record<string, any>;
const stepById = (st: Step[], id: string) =>
  st.find((s) => s.id === id) as Step;
const uses = (st: Step[], action: string) =>
  st.filter((s) => String(s.uses ?? "").startsWith(`${action}@`));
const publishStep = (pub.steps as Step[]).find((s) =>
  /\bnpm publish\b/.test(s.run ?? ""),
) as Step;

describe("pack-npm", () => {
  it("runs exactly for a stable release created by a push to main", () => {
    expect(pack.needs).toEqual(["release-please"]);
    expect(pack.if).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      "${{ !cancelled() && github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.release-please.outputs.release_created == 'true' && !contains(needs.release-please.outputs.tag_name, '-') }}",
    );
    expect(stepById(pack.steps, "pack").run).toContain(
      "^v[0-9]+\\.[0-9]+\\.[0-9]+$",
    );
  });

  it("has no credentials: contents read only, no environment, no id-token, no secrets", () => {
    expect(pack.permissions).toEqual({ contents: "read" });
    expect(pack.environment).toBeUndefined();
    expect(JSON.stringify(pack)).not.toContain("secrets.");
    expect(JSON.stringify(pack)).not.toContain("id-token");
    expect(JSON.stringify(pack)).not.toContain("NODE_AUTH_TOKEN");
  });

  it("checks out without credentials or cache and uploads the tarball", () => {
    const [checkout] = uses(pack.steps, "actions/checkout");
    expect(checkout?.with["persist-credentials"]).toBe(false);
    const [node] = uses(pack.steps, "actions/setup-node");
    expect(node?.with.cache).toBeUndefined();
    const [up] = uses(pack.steps, "actions/upload-artifact");
    expect(up?.with.name).toBe("npm-tarball");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(pack.outputs.sha256).toBe("${{ steps.pack.outputs.sha256 }}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(pack.outputs.version).toBe("${{ steps.pack.outputs.version }}");
  });

  it("allows only package.json, LICENSE, dist/ and assets/, requires LICENSE and the bin, and runs it", () => {
    const run = stepById(pack.steps, "pack").run as string;
    expect(run).toContain("npm pkg delete private devDependencies");
    expect(run).toContain("cp ../../LICENSE LICENSE");
    expect(run).toContain(
      "^package/(package\\.json|LICENSE|dist/.+|assets/.+)$",
    );
    expect(run).toContain("package/LICENSE package/dist/index.js");
    expect(run).toContain('"oa-bus $version"');
    expect(run).toContain("sha256sum");
  });
});

describe("publish-npm", () => {
  it("runs exactly after a successful pack-npm on a push to main", () => {
    expect(pub.needs).toEqual(["release-please", "pack-npm"]);
    expect(pub.if).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
      "${{ !cancelled() && github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.pack-npm.result == 'success' }}",
    );
  });

  it("reads contents and signs provenance in the npm-publish Environment", () => {
    expect(pub.permissions).toEqual({
      contents: "read",
      "id-token": "write",
    });
    expect(pub.environment).toBe("npm-publish");
  });

  it("checks out nothing and installs nothing from the repository", () => {
    expect(uses(pub.steps, "actions/checkout")).toEqual([]);
    expect(uses(pub.steps, "pnpm/action-setup")).toEqual([]);
    const runs = (pub.steps as Step[]).map((s) => s.run ?? "").join("\n");
    expect(runs).not.toMatch(/\bpnpm\b|npm (ci|pack|run)\b/);
    // The one install is the pinned npm, without lifecycle scripts.
    expect(runs.match(/npm install/g)).toHaveLength(1);
    expect(runs).toContain("npm install -g --ignore-scripts npm@11.6.2");
    const [node] = uses(pub.steps, "actions/setup-node");
    expect(node?.with["node-version"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(node?.with["node-version-file"]).toBeUndefined();
    expect(node?.with.cache).toBeUndefined();
  });

  it("verifies the tarball against pack-npm's output, not the artifact", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(pub.env.SHA256).toBe("${{ needs.pack-npm.outputs.sha256 }}");
    const run = stepById(pub.steps, "check").run as string;
    expect(run).toContain('echo "$SHA256  $tgz" | sha256sum -c -');
    const [down] = uses(pub.steps, "actions/download-artifact");
    expect(down?.with.name).toBe("npm-tarball");
  });

  it("the token reaches only the publish step, which publishes with provenance and no scripts", () => {
    expect(raw.match(/secrets\.NPM_TOKEN/g)).toHaveLength(1);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(publishStep.env.NODE_AUTH_TOKEN).toBe("${{ secrets.NPM_TOKEN }}");
    expect(pub.env.NODE_AUTH_TOKEN).toBeUndefined();
    expect(publishStep.run).toBe(
      'npm publish "$TARBALL" --provenance --access public --ignore-scripts',
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(publishStep.env.TARBALL).toBe("${{ steps.check.outputs.tarball }}");
    expect(publishStep.if).toBe("steps.check.outputs.publish == 'true'");
    expect(raw).toContain("delete the NODE_AUTH_TOKEN line");
  });
});

describe("both jobs", () => {
  it("pin every action by SHA, and no run block interpolates an expression", () => {
    for (const job of [pack, pub])
      for (const s of job.steps as Step[]) {
        if (s.uses) expect(s.uses).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
        expect(s.run ?? "").not.toContain("${{");
      }
  });
});

// publish-npm's check step, run with a stub npm and a scratch tarball.
describe("publish-npm check step", () => {
  const runCheck = (npmBody: string, opts: { sha?: string } = {}) => {
    const sb = sandbox({ npm: npmBody });
    mkdirSync(join(sb.dir, "npm"));
    const tgz = join(sb.dir, "npm/open-artifacts-bus-1.2.3.tgz");
    writeFileSync(tgz, "tarball bytes");
    const real = sb.run(["sha256sum", tgz]).out.split(" ")[0] as string;
    const out = join(sb.dir, "out");
    writeFileSync(out, "");
    const r = sb.run(["bash", "-e", "-c", stepById(pub.steps, "check").run], {
      env: {
        PACKAGE: "@open-artifacts/bus",
        VERSION: "1.2.3",
        SHA256: opts.sha ?? real,
        RUNNER_TEMP: sb.dir,
        GITHUB_OUTPUT: out,
      },
    });
    return { ...r, tgz, output: readFileSync(out, "utf8"), log: sb.log() };
  };

  it("publishes when the package is not on npm yet (E404)", () => {
    const r = runCheck('echo "npm error code E404" >&2; exit 1');
    expect(r.code).toBe(0);
    expect(r.output).toBe(`tarball=${r.tgz}\npublish=true\n`);
    expect(r.log).toEqual(["npm view @open-artifacts/bus@1.2.3 version"]);
  });
  it("publishes when the package exists without this version (empty answer)", () => {
    const r = runCheck("exit 0");
    expect(r.code).toBe(0);
    expect(r.output).toContain("publish=true");
  });
  it("skips when the version is already on npm, so a re-run is a no-op", () => {
    const r = runCheck("echo 1.2.3");
    expect(r.code).toBe(0);
    expect(r.output).toBe("publish=false\n");
  });
  it("fails closed on any other npm error", () => {
    const r = runCheck('echo "npm error code E500" >&2; exit 1');
    expect(r.code).not.toBe(0);
    expect(r.output).toBe("");
  });
  it("fails before asking npm when the tarball's sha256 differs", () => {
    const r = runCheck("echo 1.2.3", { sha: "0".repeat(64) });
    expect(r.code).not.toBe(0);
    expect(r.output).toBe("");
    expect(r.log).toEqual([]);
  });
});
