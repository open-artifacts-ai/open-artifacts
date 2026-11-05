// #1301: release-please.yml's publish-npm job publishes @open-artifacts/bus to
// npm, with provenance, only for a stable release from a push to main. The
// npm token lives in the npm-publish Environment and reaches one step.
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
const job: any = parse(raw).jobs["publish-npm"];
// biome-ignore lint/suspicious/noExplicitAny: untyped YAML
type Step = Record<string, any>;
const steps: Step[] = job.steps;
const byId = (id: string) => steps.find((s) => s.id === id) as Step;
const publish = steps.find((s) => /\bnpm publish\b/.test(s.run ?? "")) as Step;

describe("publish-npm", () => {
  it("runs only for a stable release created by a push to main", () => {
    expect(job.needs).toEqual(["release-please"]);
    for (const part of [
      "github.event_name == 'push'",
      "github.ref == 'refs/heads/main'",
      "needs.release-please.outputs.release_created == 'true'",
      "!contains(needs.release-please.outputs.tag_name, '-')",
    ])
      expect(job.if).toContain(part);
    expect(byId("version").run).toContain("^v[0-9]+\\.[0-9]+\\.[0-9]+$");
  });

  it("reads contents and signs provenance; nothing else", () => {
    expect(job.permissions).toEqual({
      contents: "read",
      "id-token": "write",
    });
    expect(job.environment).toBe("npm-publish");
  });

  it("pins every action by SHA and checks out without credentials or cache", () => {
    for (const s of steps.filter((s) => s.uses))
      expect(s.uses).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
    const checkout = steps.find((s) =>
      String(s.uses).startsWith("actions/checkout@"),
    ) as Step;
    expect(checkout.with["persist-credentials"]).toBe(false);
    const node = steps.find((s) =>
      String(s.uses).startsWith("actions/setup-node@"),
    ) as Step;
    expect(node.with.cache).toBeUndefined();
    expect(node.with["registry-url"]).toBe("https://registry.npmjs.org");
  });

  it("the token reaches only the publish step, which publishes the checked tarball with provenance", () => {
    expect(raw.match(/secrets\.NPM_TOKEN/g)).toHaveLength(1);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(publish.env.NODE_AUTH_TOKEN).toBe("${{ secrets.NPM_TOKEN }}");
    expect(job.env?.NODE_AUTH_TOKEN).toBeUndefined();
    expect(publish.run).toBe(
      'npm publish "$TARBALL" --provenance --access public',
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal workflow expression
    expect(publish.env.TARBALL).toBe("${{ steps.pack.outputs.tarball }}");
    expect(steps.indexOf(publish)).toBeGreaterThan(steps.indexOf(byId("pack")));
    expect(publish.if).toBe("steps.version.outputs.publish == 'true'");
  });

  it("no run block interpolates an expression", () => {
    for (const s of steps) expect(s.run ?? "").not.toContain("${{");
  });

  it("the tarball check allows only package.json, dist/ and assets/, and runs the bin", () => {
    const run = byId("pack").run as string;
    expect(run).toContain("npm pkg delete private devDependencies");
    expect(run).toContain("^package/(package\\.json|dist/.+|assets/.+)$");
    expect(run).toContain('"oa-bus $VERSION"');
  });

  // The version step's script, run with a stub npm and a scratch checkout.
  describe("version step", () => {
    const runVersion = (npmBody: string, rootVersion = "1.2.3") => {
      const sb = sandbox({ npm: npmBody });
      const cwd = join(sb.dir, "packages/bus-cli");
      mkdirSync(cwd, { recursive: true });
      writeFileSync(
        join(sb.dir, "package.json"),
        JSON.stringify({ version: rootVersion }),
      );
      const out = join(sb.dir, "out");
      writeFileSync(out, "");
      const r = sb.run(["bash", "-e", "-c", byId("version").run], {
        cwd,
        env: {
          TAG: "v1.2.3",
          PACKAGE: "@open-artifacts/bus",
          RUNNER_TEMP: sb.dir,
          GITHUB_OUTPUT: out,
        },
      });
      return { ...r, output: readFileSync(out, "utf8"), log: sb.log() };
    };

    it("publishes when the package is not on npm yet (E404)", () => {
      const r = runVersion('echo "npm error code E404" >&2; exit 1');
      expect(r.code).toBe(0);
      expect(r.output).toBe("version=1.2.3\npublish=true\n");
      expect(r.log).toEqual(["npm view @open-artifacts/bus@1.2.3 version"]);
    });
    it("publishes when the package exists without this version (empty answer)", () => {
      const r = runVersion("exit 0");
      expect(r.code).toBe(0);
      expect(r.output).toContain("publish=true");
    });
    it("skips when the version is already on npm, so a re-run is a no-op", () => {
      const r = runVersion("echo 1.2.3");
      expect(r.code).toBe(0);
      expect(r.output).toBe("publish=false\n");
    });
    it("fails closed on any other npm error", () => {
      const r = runVersion('echo "npm error code E500" >&2; exit 1');
      expect(r.code).not.toBe(0);
      expect(r.output).toBe("");
    });
    it("fails when package.json at the tag is another version", () => {
      const r = runVersion("exit 0", "1.2.4");
      expect(r.code).not.toBe(0);
      expect(r.log).toEqual([]);
    });
  });
});
