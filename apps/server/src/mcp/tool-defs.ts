// Tool names, descriptions, input schemas and one example each: the single
// source for the MCP server, tool-manifest.json (scripts/emit-tool-manifest.ts)
// and the skill (scripts/emit-skill.ts). Data plus @oa/shared (built, so the
// build scripts can load it in plain Node). Keep them vendor-neutral.
import {
  ArtifactDataDeleteInputSchema,
  ArtifactDataGetInputSchema,
  ArtifactDataListInputSchema,
  ArtifactDataQueryInputSchema,
  ArtifactDataSetInputSchema,
  ArtifactDataUpdateInputSchema,
  CreateUploadInputSchema,
  GetArtifactInputSchema,
  IdInputSchema,
  LIMITS,
  ListQuerySchema,
  ListSpacesInputSchema,
  PublishToolInputSchema,
  RestoreVersionInputSchema,
  SearchQuerySchema,
  SetVisibilityInputSchema,
  ShareArtifactInputSchema,
  UnshareInputSchema,
} from "@oa/shared";

const INLINE = `${LIMITS.inlineBytes / 1024} KB`;
/** A well-formed artifact id for the examples. */
const ID = "7Hq2mXc9KpR4tWbZ";

export const TOOL_DEFS = [
  {
    name: "publish_artifact",
    inputSchema: PublishToolInputSchema,
    example: {
      title: "Q3 report",
      format: "markdown",
      content: "# Q3\n\nRevenue is up.",
      message: "First draft",
    },
    description: `Publish an artifact, or a new version when \`id\` is given. Pass \`content\` (one file, with \`format\`) or \`files\` (path → text, or { base64 } for binary, or { uploadId } from create_upload) plus \`entry\`. Inline content (content, text and base64 together) is limited to ${INLINE}; for more, call create_upload, PUT the bytes to its url, then pass { uploadId } in \`files\`. To create it in a shared space, pass \`spaceId\` from list_spaces (new artifacts only). On a public artifact that declares db, anonymous visitors' writes fail with anon_writes_disabled unless allowAnonymousWrites is true. Returns id, version and view URL.`,
  },
  {
    name: "create_upload",
    inputSchema: CreateUploadInputSchema,
    example: { path: "video.mp4", size: 3_000_000, contentType: "video/mp4" },
    description: `Get a signed URL to PUT one large file (over the ${INLINE} inline limit, up to 25 MB), then publish_artifact with \`id\` = the returned artifactId and \`files: { "<path>": { uploadId } }\`. Omit artifactId to reserve a new artifact id; reuse it for the artifact's other uploads.`,
  },
  {
    name: "get_artifact",
    inputSchema: GetArtifactInputSchema,
    example: { id: ID, path: "index.html" },
    description:
      "Read an artifact's metadata (with its space and what you may do, when spaces are on) and one version (latest by default). Returns a file's text inline when it is text and at most 1 MB; otherwise a short-lived downloadUrl. Download URLs expire after 10 minutes; call get_artifact again for a fresh one.",
  },
  {
    name: "list_artifacts",
    inputSchema: ListQuerySchema,
    example: { scope: "mine", format: "html", limit: 10 },
    description:
      "List artifacts you can see, newest first. Filter by scope, format, visibility, owner, agent or updatedSince; page with cursor.",
  },
  {
    name: "search_artifacts",
    inputSchema: SearchQuerySchema,
    example: { q: "roadmap" },
    description:
      "Full-text search artifact titles, descriptions and content. Returns matches with snippets; page with cursor.",
  },
  {
    name: "list_versions",
    inputSchema: IdInputSchema,
    example: { id: ID },
    description: "List an artifact's versions, newest first.",
  },
  {
    name: "restore_version",
    inputSchema: RestoreVersionInputSchema,
    example: { id: ID, version: 2 },
    description:
      "Restore an earlier version by publishing a copy of it as the new latest version.",
  },
  {
    name: "share_artifact",
    inputSchema: ShareArtifactInputSchema,
    example: { id: ID, email: "sam@example.com", role: "viewer" },
    description:
      "Share an artifact with an email address as viewer or editor. Owner or space manager only.",
  },
  {
    name: "unshare_artifact",
    inputSchema: UnshareInputSchema,
    example: { id: ID, email: "sam@example.com" },
    description:
      "Remove an email address's share. Owner or space manager only.",
  },
  {
    name: "set_visibility",
    inputSchema: SetVisibilityInputSchema,
    example: { id: ID, visibility: "team" },
    description:
      "Set who can open an artifact: private (you and shares), team (all members) or public (anyone with the link). Owner or space manager only. On a public artifact that declares db, anonymous visitors' writes fail with anon_writes_disabled unless allowAnonymousWrites is true; the result then carries a warning.",
  },
  {
    name: "delete_artifact",
    inputSchema: IdInputSchema,
    example: { id: ID },
    description:
      "Delete an artifact. It can be restored from the dashboard for 30 days. Owner or space manager only.",
  },
  {
    name: "artifact_data_get",
    inputSchema: ArtifactDataGetInputSchema,
    example: { id: ID, collection: "votes", docId: "sam" },
    description:
      "Read one document from an artifact's live-page data collection.",
  },
  {
    name: "artifact_data_list",
    inputSchema: ArtifactDataListInputSchema,
    example: { id: ID, collection: "votes", limit: 50 },
    description:
      "List documents in an artifact's live-page data collection; page with cursor.",
  },
  {
    name: "artifact_data_query",
    inputSchema: ArtifactDataQueryInputSchema,
    example: {
      id: ID,
      collection: "votes",
      query: { where: { choice: "yes" }, limit: 20 },
    },
    description:
      "Query an artifact's live-page data collection with equality `where`, `orderBy`, `order` and `limit`.",
  },
  {
    name: "artifact_data_set",
    inputSchema: ArtifactDataSetInputSchema,
    example: {
      id: ID,
      collection: "votes",
      docId: "sam",
      data: { choice: "yes" },
    },
    description:
      "Create or replace a document in an artifact's live-page data collection. Anyone who can view the artifact may write (as on the page itself).",
  },
  {
    name: "artifact_data_update",
    inputSchema: ArtifactDataUpdateInputSchema,
    example: {
      id: ID,
      collection: "votes",
      docId: "sam",
      patch: { choice: "no" },
    },
    description:
      "Merge top-level fields into a document in an artifact's live-page data collection. Anyone who can view the artifact may write (as on the page itself).",
  },
  {
    name: "artifact_data_delete",
    inputSchema: ArtifactDataDeleteInputSchema,
    example: { id: ID, collection: "votes", docId: "sam" },
    description:
      "Delete a document from an artifact's live-page data collection. Anyone who can view the artifact may write (as on the page itself).",
  },
  {
    name: "list_spaces",
    inputSchema: ListSpacesInputSchema,
    example: {},
    description:
      "List the spaces you can publish into: your personal space first, then shared spaces where you are an editor or manager. Pass a space's id as publish_artifact's spaceId.",
  },
] as const;

export type ToolName = (typeof TOOL_DEFS)[number]["name"];

type ToolDef = (typeof TOOL_DEFS)[number];

const defOf = <N extends ToolName>(name: N): Extract<ToolDef, { name: N }> => {
  const d = TOOL_DEFS.find((t) => t.name === name);
  if (!d) throw new Error(`unknown tool ${name}`);
  return d as Extract<ToolDef, { name: N }>;
};

export const describeTool = (name: ToolName): string => defOf(name).description;

/** registerTool's config for `name`: its description and input schema. */
export const toolConfig = <N extends ToolName>(name: N) => {
  const d = defOf(name);
  return {
    description: d.description as string,
    inputSchema: d.inputSchema as Extract<ToolDef, { name: N }>["inputSchema"],
  };
};
