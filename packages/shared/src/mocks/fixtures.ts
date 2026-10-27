import type {
  ArtifactSummary,
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
  data: { artifactId: string; collection: string; doc: DataDoc }[];
  storage: { artifactId: string; entry: StorageEntry }[];
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
      versionsPublished: 0,
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
};
