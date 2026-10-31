export type InstallId = string;

export interface CreateInput {
  slug: string;
  ownerEmail: string;
  plan: "paid";
  vars?: Record<string, string>;
  testHooks?: boolean;
  resumeId?: InstallId;
  /**
   * The id a fresh install gets (the hosted provisioner reserves it first);
   * a rerun resumes that install. The slug held by another install, or this
   * id on another slug, is refused. Not with resumeId.
   */
  installId?: InstallId;
}

export interface Install {
  id: InstallId;
  slug: string;
  appHost: string;
  contentHost: string;
  version: string;
  /** The owner's 0600 PAT file; absent when CI's ephemeral token ran the selftest. */
  patFile?: string;
}

export interface Release {
  version: string;
  bundleKey: string;
}

export interface UpgradeResult {
  id: InstallId;
  from: string;
  to: string;
  ok: boolean;
  rolledBack: boolean;
  /** A failed upgrade that could not roll back (a DO tag changed, or the previous version is refused): it stays on `to`. */
  forwardFix?: boolean;
  reason?: string;
  /** Something the operator should know about a run that still succeeded. */
  note?: string;
}

export class NotInM1 extends Error {
  override name = "NotInM1";
}

export interface Provisioner {
  create(i: CreateInput): Promise<Install>;
  upgrade(id: InstallId, to: Release): Promise<UpgradeResult>;
  rollback(id: InstallId): Promise<UpgradeResult>;
  delete(id: InstallId, confirm: string): Promise<void>;
  export(id: InstallId, dest: string): Promise<never>;
  import(src: string, i: CreateInput): Promise<never>;
}
