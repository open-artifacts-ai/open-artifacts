import type { BusRole, BusRoleProposal } from "../bus-notices.js";
import type {
  ArtifactSummary,
  BusAgent,
  BusMachine,
  DataDoc,
  Me,
  Member,
  OAuthClient,
  Share,
  StorageEntry,
  Token,
  UserRef,
  VersionInfo,
} from "../schemas.js";

// Literal 16-char base58 ids (same shape as newId()) so fixtures stay deterministic.
const ID = {
  ada: "Ab3dEfGhJk4mNpQr",
  bob: "Bc4eFgHjKm5nPqRs",
  landing: "Cd5fGhJkLm6nPqRs",
  notes: "De6gHjKmNp7qRsTu",
  script: "Ef7hJkLmNp8qRsTv",
  report: "Fg8jKmNpQr9sTuVw",
  poll: "Gh9kLmNpQrAsTuVx",
  guide: "HjAmNpQrSt2uVwXy",
  draft: "JkBnPqRsTu5vWxYz",
} as const;

const ada: UserRef & { email: string } = {
  id: ID.ada,
  email: "ada@example.com",
  name: "Ada Lovelace",
};
const bob: UserRef & { email: string } = {
  id: ID.bob,
  email: "bob@example.com",
  name: "Bob Builder",
};
const agent = { name: "Claude Code", version: "2.0" };
const caps = (db = false) => ({ db, viewer: false, storage: false });

const art = (
  id: string,
  title: string,
  format: ArtifactSummary["format"],
  o: Partial<ArtifactSummary> = {},
): ArtifactSummary => ({
  id,
  title,
  description: null,
  format,
  visibility: "private",
  owner: ada,
  currentVersion: 1,
  createdAt: "2026-01-02T10:00:00.000Z",
  updatedAt: "2026-01-03T10:00:00.000Z",
  deletedAt: null,
  lastAgent: agent,
  thumbnailUrl: null,
  thumbnailVersion: null,
  access: "owner",
  capabilities: caps(),
  allowAnonymousWrites: false,
  // #682: the Comments setting, on by default.
  comments: true,
  // #681: as the 0014 backfill maps rows.
  dataWriters:
    o.visibility === "public" && !o.allowAnonymousWrites
      ? "editors"
      : "viewers",
  ...o,
});

const ver = (
  version: number,
  entry: string,
  contentType: string,
  language: string | null = null,
  createdBy: UserRef = ada,
  extra: string[] = [],
): VersionInfo => ({
  version,
  message: version === 1 ? "Initial version" : `Update ${version}`,
  agent: agent,
  createdBy,
  createdAt: new Date(Date.UTC(2026, 0, 1 + version, 10)).toISOString(),
  entry,
  files: [entry, ...extra].map((path) => ({
    path,
    size: 1024 * version,
    contentType: path.endsWith(".css") ? "text/css" : contentType,
  })),
  language,
  textIndexed: contentType !== "application/pdf",
  format:
    contentType === "text/html"
      ? "html"
      : contentType === "text/markdown"
        ? "markdown"
        : contentType === "application/pdf"
          ? "pdf"
          : "code",
});

const members: Member[] = [
  { ...ada, role: "owner", lastSeenAt: "2026-01-03T10:00:00.000Z" },
  { ...bob, role: "member", lastSeenAt: null },
];

/** The moment the bus fixtures describe; the mocks serve them shifted to now. */
export const BUS_FIXTURE_NOW = "2026-01-03T10:00:00.000Z";

export const fixtures: {
  me: Me;
  artifacts: ArtifactSummary[];
  versions: Record<string, VersionInfo[]>;
  members: Member[];
  /** File bodies keyed `${artifactId}/${version}/${path}`; missing keys fall back to a generated body. */
  files: Record<string, string>;
  shares: Record<string, Share[]>;
  tokens: Token[];
  oauthClients: OAuthClient[];
  /** The connections (`g:<grantId>`, `t:<tokenId>`) that published each artifact; all the caller's. */
  agentVias: Record<string, string[]>;
  data: { artifactId: string; collection: string; doc: DataDoc }[];
  storage: { artifactId: string; entry: StorageEntry }[];
  /** #1293: the caller's bus machines (served with `bus: true`): live, never connected, revoked. */
  busMachines: BusMachine[];
  /** #1293: open agents on busMachines (served with `bus: true`). */
  busAgents: BusAgent[];
  /** #1293: role addresses (served with `bus: true`): one held, one vacant. */
  busRoles: BusRole[];
  /** #1293: one pending role proposal (served with `bus: true`). */
  busRoleProposals: BusRoleProposal[];
} = {
  me: {
    user: members[0] as Member,
    instance: {
      name: "Acme Artifacts",
      defaultVisibility: "private",
      appUrl: "https://app.example.com",
      mcpUrl: "https://app.example.com/mcp",
      emailEnabled: false,
      plan: "free",
      update: null,
    },
    displayName: null,
    suggestedName: null,
    needsDisplayName: false,
  },
  artifacts: [
    art(ID.landing, "Landing page", "html", {
      description: "Marketing mockup",
      currentVersion: 2,
      thumbnailUrl: `/api/v1/artifacts/${ID.landing}/thumbnail?v=2`,
      thumbnailVersion: 2,
    }),
    art(ID.notes, "Meeting notes", "markdown", { visibility: "team" }),
    art(ID.script, "Parser script", "code", { currentVersion: 25 }),
    art(ID.report, "Q4 report", "pdf", { visibility: "public" }),
    art(ID.poll, "Team poll", "html", {
      visibility: "public",
      capabilities: caps(true),
      allowAnonymousWrites: true,
    }),
    art(ID.draft, "Shared draft", "markdown", {
      owner: bob,
      access: "editor",
      visibility: "private",
    }),
    art(ID.guide, "Onboarding guide", "markdown", {
      owner: bob,
      access: "viewer",
      visibility: "team",
    }),
  ],
  versions: {
    [ID.landing]: [
      ver(2, "index.html", "text/html", null, ada, ["style.css"]),
      ver(1, "index.html", "text/html"),
    ],
    [ID.notes]: [ver(1, "notes.md", "text/markdown")],
    // 25 versions (newest first) so clients exercise `before` paging.
    [ID.script]: Array.from({ length: 25 }, (_, i) =>
      ver(25 - i, "parse.ts", "text/plain", "typescript"),
    ),
    [ID.report]: [ver(1, "report.pdf", "application/pdf")],
    [ID.poll]: [ver(1, "index.html", "text/html")],
    [ID.draft]: [ver(1, "draft.md", "text/markdown", null, bob)],
    [ID.guide]: [ver(1, "guide.md", "text/markdown", null, bob)],
  },
  members,
  files: {
    [`${ID.landing}/1/index.html`]: "<!doctype html><h1>Landing v1</h1>",
    [`${ID.landing}/2/index.html`]:
      '<!doctype html><link rel="stylesheet" href="style.css"><h1>Landing v2</h1>',
    [`${ID.landing}/2/style.css`]: "h1 { color: teal; }",
  },
  shares: {
    [ID.landing]: [
      {
        email: "bob@example.com",
        role: "viewer",
        createdAt: "2026-01-02T11:00:00.000Z",
      },
    ],
  },
  tokens: [
    {
      id: "Jk2mNpQrSt3uVwXy",
      label: "laptop",
      createdAt: "2026-01-02T10:00:00.000Z",
      lastUsedAt: null,
      versionsPublished: 1,
    },
  ],
  oauthClients: [
    {
      grantId: "Km3nPqRsTu4vWxYz",
      clientName: "Example MCP client",
      createdAt: "2026-01-02T10:00:00.000Z",
      redirectKind: "computer",
      approvedFrom: { browser: "chrome", os: "macos" },
      lastUsedAt: "2026-01-02T12:00:00.000Z",
      clientVersion: "1.2.0",
      versionsPublished: 3,
    },
  ],
  agentVias: {
    [ID.landing]: ["g:Km3nPqRsTu4vWxYz"],
    [ID.notes]: ["g:Km3nPqRsTu4vWxYz"],
    [ID.report]: ["g:Km3nPqRsTu4vWxYz"],
    [ID.script]: ["t:Jk2mNpQrSt3uVwXy"],
  },
  data: [
    {
      artifactId: ID.poll,
      collection: "votes",
      doc: {
        id: "v1",
        data: { choice: "a" },
        updatedAt: "2026-01-03T10:00:00.000Z",
        updatedBy: ada.id,
      },
    },
  ],
  storage: [
    {
      artifactId: ID.poll,
      entry: {
        key: "theme",
        value: "dark",
        updatedAt: "2026-01-03T10:00:00.000Z",
      },
    },
  ],
  busMachines: [
    {
      id: "BmA1nPqRsTu4vWxY",
      label: "leo-work",
      createdAt: "2026-01-02T10:00:00.000Z",
      lastUsedAt: "2026-01-03T10:00:00.000Z",
      revokedAt: null,
      connected: true,
    },
    {
      id: "BmB2nPqRsTu4vWxY",
      label: "home-desktop",
      createdAt: "2026-01-01T10:00:00.000Z",
      lastUsedAt: null,
      revokedAt: null,
      connected: false,
    },
    {
      id: "BmC3nPqRsTu4vWxY",
      label: "old-laptop",
      createdAt: "2025-12-01T10:00:00.000Z",
      lastUsedAt: "2025-12-20T10:00:00.000Z",
      revokedAt: "2025-12-21T10:00:00.000Z",
      connected: false,
    },
  ],
  busAgents: [
    {
      id: "BaA1nPqRsTu4vWxY",
      namespace: "github.com/open-artifacts-ai/open-artifacts",
      name: "oa-manager",
      kind: "claude-code",
      machineId: "BmA1nPqRsTu4vWxY",
      machineLabel: "leo-work",
      global: false,
      state: "live",
      running: true,
      since: null,
      updatedAt: "2026-01-03T10:00:00.000Z",
      status: "working",
      statusLabel: "Reviewing the release candidate",
      statusAt: "2026-01-03T10:00:00.000Z",
    },
    {
      id: "BaB2nPqRsTu4vWxY",
      namespace: "github.com/open-artifacts-ai/open-artifacts",
      name: "oa-design",
      kind: "claude-code",
      machineId: "BmA1nPqRsTu4vWxY",
      machineLabel: "leo-work",
      global: false,
      state: "live",
      running: true,
      since: null,
      updatedAt: "2026-01-03T09:58:00.000Z",
      status: "working",
      statusLabel: "Writing the bus pages spec",
      statusAt: "2026-01-03T09:58:00.000Z",
    },
    {
      id: "BaC3nPqRsTu4vWxY",
      namespace: "github.com/open-artifacts-ai/open-artifacts",
      name: "oa-product",
      kind: "pi",
      machineId: "BmB2nPqRsTu4vWxY",
      machineLabel: "home-desktop",
      global: false,
      state: "queued",
      running: true,
      since: null,
      updatedAt: "2026-01-03T09:38:00.000Z",
      status: "idle",
      statusLabel: "Idle",
      statusAt: "2026-01-03T09:38:00.000Z",
    },
    {
      id: "BaD4nPqRsTu4vWxY",
      namespace: "github.com/open-artifacts-ai/open-bus",
      name: "bus-lead",
      kind: "pi",
      machineId: "BmA1nPqRsTu4vWxY",
      machineLabel: "leo-work",
      global: false,
      state: "live",
      running: true,
      since: null,
      updatedAt: "2026-01-03T09:59:00.000Z",
      status: "working",
      statusLabel: "Moving the bus into the instance",
      statusAt: "2026-01-03T09:59:00.000Z",
    },
    {
      id: "BaE5nPqRsTu4vWxY",
      namespace: "github.com/leourbina/jobs-paris",
      name: "claude",
      kind: "claude-code",
      machineId: "BmA1nPqRsTu4vWxY",
      machineLabel: "leo-work",
      global: false,
      state: "live",
      running: true,
      since: null,
      updatedAt: "2026-01-03T09:30:00.000Z",
    },
    {
      id: "BaF6nPqRsTu4vWxY",
      namespace: "notes",
      name: "planner",
      kind: "claude-code",
      machineId: "BmA1nPqRsTu4vWxY",
      machineLabel: "leo-work",
      global: false,
      state: "live",
      running: true,
      since: null,
      updatedAt: "2026-01-03T09:20:00.000Z",
    },
    {
      id: "BaG7nPqRsTu4vWxY",
      namespace: "notes",
      name: "pi-2",
      kind: "pi",
      machineId: "BmB2nPqRsTu4vWxY",
      machineLabel: "home-desktop",
      global: false,
      state: "queued",
      running: true,
      since: null,
      updatedAt: "2026-01-03T08:00:00.000Z",
    },
    {
      id: "BaH8nPqRsTu4vWxY",
      namespace: "github.com/open-artifacts-ai/open-artifacts",
      name: "memory",
      kind: "pi",
      machineId: "BmA1nPqRsTu4vWxY",
      machineLabel: "leo-work",
      global: true,
      state: "live",
      running: true,
      since: null,
      updatedAt: "2026-01-03T09:00:00.000Z",
    },
  ],
  busRoles: [
    {
      id: "BrA1nPqRsTu4vWxY",
      namespace: "github.com/open-artifacts-ai/open-artifacts",
      name: "manager",
      agentId: "BaA1nPqRsTu4vWxY",
      holderName: "oa-manager",
      vacant: false,
      setAt: "2026-01-02T10:00:00.000Z",
    },
    {
      id: "BrB2nPqRsTu4vWxY",
      namespace: "github.com/open-artifacts-ai/open-bus",
      name: "reviewer",
      agentId: null,
      holderName: null,
      vacant: true,
      setAt: "2026-01-01T10:00:00.000Z",
    },
  ],
  busRoleProposals: [
    {
      id: "BpA1nPqRsTu4vWxY",
      action: "repoint",
      namespace: "github.com/open-artifacts-ai/open-artifacts",
      name: "manager",
      roleId: "BrA1nPqRsTu4vWxY",
      agentId: "BaB2nPqRsTu4vWxY",
      agentName: "oa-design",
      priorAgentId: "BaA1nPqRsTu4vWxY",
      priorHolderName: "oa-manager",
      status: "pending",
      reason: null,
      createdAt: "2026-01-03T09:56:00.000Z",
      expiresAt: "2026-01-03T10:11:00.000Z",
      decidedAt: null,
    },
  ],
};
