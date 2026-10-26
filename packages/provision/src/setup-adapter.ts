// The self-hosted Provisioner (P1 Task 8): create, upgrade and rollback are
// @oa/setup runs (`run` and `rollbackCommand`, given by the caller, since
// setup is a script package this one does not build against), read back from
// setup's --json lines. Delete, export and import are NotInM1: self-hosters
// delete in their own dashboard (ruling: no destructive self-hosted path in M1).
import {
  type CreateInput,
  type Install,
  type InstallId,
  NotInM1,
  type Provisioner,
  type Release,
  type UpgradeResult,
} from "./types.js";

/** @oa/setup's Deps, as far as the adapter needs it (out is wrapped). */
export interface SetupDeps {
  out: (line: string) => void;
  [k: string]: unknown;
}

/** @oa/setup's `run` and `rollbackCommand`; both resolve to an exit code. */
export interface SetupFns {
  run(argv: string[], deps: SetupDeps, root: string): Promise<number>;
  rollbackCommand(
    argv: string[],
    deps: SetupDeps,
    root: string,
  ): Promise<number>;
}

interface Line {
  step: string;
  status: string;
  message: string;
  data?: Record<string, unknown>;
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

export class SetupProvisioner implements Provisioner {
  constructor(
    private readonly o: { deps: SetupDeps; root: string; setup: SetupFns },
  ) {}

  /** Runs one setup call; every line still reaches the caller's out. */
  private async call(
    fn: "run" | "rollbackCommand",
    argv: string[],
  ): Promise<{ code: number; lines: Line[] }> {
    const lines: Line[] = [];
    const deps: SetupDeps = {
      ...this.o.deps,
      out: (l: string) => {
        try {
          const j = JSON.parse(l);
          if (j && typeof j === "object" && typeof j.step === "string")
            lines.push(j as Line);
        } catch {}
        this.o.deps.out(l);
      },
    };
    const code = await this.o.setup[fn](argv, deps, this.o.root);
    return { code, lines };
  }

  private static dataOf(lines: Line[], step: string) {
    return lines.filter((l) => l.step === step).at(-1)?.data ?? {};
  }

  private static failure(lines: Line[], code: number): string {
    const l = lines
      .filter((x) => x.status === "error" || x.status === "action_required")
      .at(-1);
    return l ? `${l.step}: ${l.message}` : `setup exited ${code}`;
  }

  async create(i: CreateInput): Promise<Install> {
    if (i.testHooks)
      throw new Error("test hooks are hosted only; setup never deploys them");
    const vars = Object.entries(i.vars ?? {}).flatMap(([k, v]) => [
      "--var",
      `${k}=${v}`,
    ]);
    const { code, lines } = await this.call("run", [
      "--json",
      "--yes",
      "--solo",
      "--name",
      i.slug,
      "--owner-email",
      i.ownerEmail,
      ...vars,
    ]);
    if (code !== 0) throw new Error(SetupProvisioner.failure(lines, code));
    const st = SetupProvisioner.dataOf(lines, "state");
    const dep = SetupProvisioner.dataOf(lines, "deploy");
    const tok = SetupProvisioner.dataOf(lines, "owner-token");
    const out = {
      id: str(st.name),
      slug: i.slug,
      appHost: str(st.appHost),
      contentHost: str(st.contentHost),
      version: str(dep.deployedVersion),
      patFile: str(tok.tokenFile),
    };
    const missing = Object.entries(out).filter(([, v]) => v === undefined);
    if (missing.length > 0)
      throw new Error(
        `setup succeeded but did not report ${missing.map(([k]) => k).join(", ")}`,
      );
    return out as Install;
  }

  /** Setup deploys the checkout: `to.version` must be what it deployed. */
  async upgrade(id: InstallId, to: Release): Promise<UpgradeResult> {
    const { code, lines } = await this.call("run", [
      "--upgrade",
      "--json",
      "--name",
      id,
    ]);
    const dep = SetupProvisioner.dataOf(lines, "deploy");
    const from = str(dep.liveVersion) ?? "";
    const deployed = str(dep.deployedVersion);
    if (code !== 0)
      return {
        id,
        from,
        to: deployed ?? to.version,
        ok: false,
        rolledBack: false,
        reason: SetupProvisioner.failure(lines, code),
      };
    if (deployed !== to.version)
      return {
        id,
        from,
        to: deployed ?? "",
        ok: false,
        rolledBack: false,
        reason: `setup deployed ${deployed ?? "an unknown version"}, not ${to.version}; check out ${to.version} and rerun`,
      };
    return { id, from, to: deployed, ok: true, rolledBack: false };
  }

  async rollback(id: InstallId): Promise<UpgradeResult> {
    const { code, lines } = await this.call("rollbackCommand", [
      "--json",
      "--name",
      id,
    ]);
    const d = SetupProvisioner.dataOf(lines, "rollback");
    if (code !== 0)
      return {
        id,
        from: "",
        to: "",
        ok: false,
        rolledBack: false,
        reason: SetupProvisioner.failure(lines, code),
      };
    return {
      id,
      from: str(d.from) ?? "",
      to: str(d.to) ?? "",
      ok: true,
      rolledBack: true,
    };
  }

  async delete(_id: InstallId, _confirm: string): Promise<void> {
    throw new NotInM1(
      "self-hosted installs are deleted in their own Cloudflare dashboard",
    );
  }

  async export(_id: InstallId, _dest: string): Promise<never> {
    throw new NotInM1("export is not in M1");
  }

  async import(_src: string, _i: CreateInput): Promise<never> {
    throw new NotInM1("import is not in M1");
  }
}
