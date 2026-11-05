// #1293: namespaces as the Agents rail shows them (Design B, option 1).
// A repo namespace is `host/owner/repo` (bus-protocol normalizeRemote); any
// other is a folder name with no git remote.
import type { BusAgent } from "@oa/shared";

export type ParsedNamespace =
  | { kind: "repo"; ns: string; owner: string; repo: string }
  | { kind: "folder"; ns: string };

/** github.com drops its host ("acme"); another host keeps it ("gitlab.com/acme"). */
export function parseNamespace(ns: string): ParsedNamespace {
  const parts = ns.split("/");
  if (parts.length < 2) return { kind: "folder", ns };
  if (parts.length === 2)
    return {
      kind: "repo",
      ns,
      owner: parts[0] as string,
      repo: parts[1] as string,
    };
  const [host, owner, ...rest] = parts as [string, string, ...string[]];
  return {
    kind: "repo",
    ns,
    owner: host === "github.com" ? owner : `${host}/${owner}`,
    repo: rest.join("/"),
  };
}

/**
 * The short name: the repo, or owner/repo when another owner has a repo of
 * that name too (`all` is every namespace in view). Folders keep their name.
 */
export function shortName(ns: string, all: readonly string[]): string {
  const p = parseNamespace(ns);
  if (p.kind === "folder") return ns;
  const clash = all.some((o) => {
    if (o === ns) return false;
    const q = parseNamespace(o);
    return q.kind === "repo" && q.repo === p.repo && q.owner !== p.owner;
  });
  return clash ? `${p.owner}/${p.repo}` : p.repo;
}

/** The full path shown on hover and on the namespace page. */
export const fullPath = (ns: string) => ns;

export type Count = { total: number; live: number };
export type RailNamespace = Count & {
  ns: string;
  label: string;
  /** The machines its agents run on, A to Z (folders show them). */
  machines: string[];
};
export type Rail = {
  all: Count;
  orgs: (Count & { owner: string; namespaces: RailNamespace[] })[];
  folders: Count & { namespaces: RailNamespace[] };
  global: Count;
};

const count = (agents: readonly BusAgent[]): Count => ({
  total: agents.length,
  live: agents.filter((a) => a.state === "live").length,
});

/** The rail: orgs A to Z, then Other folders, then Everywhere (global agents). */
export function buildRail(agents: readonly BusAgent[]): Rail {
  const byNs = new Map<string, BusAgent[]>();
  for (const a of agents)
    byNs.set(a.namespace, [...(byNs.get(a.namespace) ?? []), a]);
  const names = [...byNs.keys()];
  const item = (ns: string): RailNamespace => {
    const list = byNs.get(ns) ?? [];
    return {
      ns,
      label: shortName(ns, names),
      machines: [...new Set(list.map((a) => a.machineLabel))].sort(),
      ...count(list),
    };
  };
  const orgs = new Map<string, RailNamespace[]>();
  const folders: RailNamespace[] = [];
  for (const ns of names) {
    const p = parseNamespace(ns);
    if (p.kind === "folder") folders.push(item(ns));
    else orgs.set(p.owner, [...(orgs.get(p.owner) ?? []), item(ns)]);
  }
  const byLabel = (a: RailNamespace, b: RailNamespace) =>
    a.label.localeCompare(b.label);
  const sum = (xs: Count[]): Count => ({
    total: xs.reduce((n, x) => n + x.total, 0),
    live: xs.reduce((n, x) => n + x.live, 0),
  });
  return {
    all: count(agents),
    orgs: [...orgs.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([owner, nss]) => ({
        owner,
        namespaces: nss.sort(byLabel),
        ...sum(nss),
      })),
    folders: { namespaces: folders.sort(byLabel), ...sum(folders) },
    global: count(agents.filter((a) => a.global)),
  };
}

/** What the roster shows: everything, one org, one namespace, Other folders, or global agents. */
export type Scope =
  | { kind: "all" }
  | { kind: "org"; owner: string }
  | { kind: "ns"; ns: string }
  | { kind: "folders" }
  | { kind: "global" };

/** `?in=` on /agents: "org:<owner>", "ns:<namespace>", "folders", "global"; anything else is all. */
export function parseScope(v: string | undefined): Scope {
  if (v === "folders" || v === "global") return { kind: v };
  if (v?.startsWith("org:") && v.length > 4)
    return { kind: "org", owner: v.slice(4) };
  if (v?.startsWith("ns:") && v.length > 3)
    return { kind: "ns", ns: v.slice(3) };
  return { kind: "all" };
}

export function scopeParam(s: Scope): string | undefined {
  switch (s.kind) {
    case "all":
      return undefined;
    case "org":
      return `org:${s.owner}`;
    case "ns":
      return `ns:${s.ns}`;
    default:
      return s.kind;
  }
}

export function inScope(a: BusAgent, s: Scope): boolean {
  const p = parseNamespace(a.namespace);
  switch (s.kind) {
    case "all":
      return true;
    case "org":
      return p.kind === "repo" && p.owner === s.owner;
    case "ns":
      return a.namespace === s.ns;
    case "folders":
      return p.kind === "folder";
    case "global":
      return a.global;
  }
}

/** "a", "a and b", "a, b and c". */
export function listOf(xs: readonly string[]): string {
  if (xs.length <= 1) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}
