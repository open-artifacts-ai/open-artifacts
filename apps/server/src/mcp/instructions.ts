// Server instructions, also served as the resource RUNTIME_DOC_URI, and the
// shared sections of the skill (scripts/emit-skill.ts). Vendor-neutral. Plain
// Node-loadable: imports only @oa/shared.
import {
  dataDocLimit,
  formatKb,
  LIMITS,
  mcpBodyLimit,
  type Plan,
} from "@oa/shared";

export const RUNTIME_DOC_URI = "openartifacts://docs/runtime";

/**
 * The plan-dependent words a section uses. INSTRUCTIONS fills them from the
 * plan; the skill template keeps them as {{tokens}} filled at request time.
 */
export type PlanText = {
  plan: string;
  dataDoc: string;
  /** After "(<plan> plan": the Paid limit on Free, nothing on Paid. */
  dataDocNote: string;
  mcpBody: string;
  /** What quota_exceeded means the instance hit. */
  quota: string;
};

/** Bytes as "N MB" when a whole MB, else as formatKb ("N KB", or exact bytes). */
export const sizeText = (b: number): string =>
  b >= 1024 * 1024 && b % (1024 * 1024) === 0
    ? `${b / 1024 / 1024} MB`
    : formatKb(b);

/**
 * The plan's words, with the instance's effective data-doc limit `docBytes`
 * (dataLimits(env).docBytes; default: the plan's).
 */
export const planText = (
  plan: Plan,
  docBytes: number = dataDocLimit(plan),
): PlanText => ({
  plan,
  dataDoc: sizeText(docBytes),
  dataDocNote:
    plan === "paid"
      ? ""
      : `; Workers Paid allows ${sizeText(LIMITS.dataDocBytesPaid)}`,
  // KB, as mcpTooLargeMessage states it.
  mcpBody: formatKb(mcpBodyLimit(plan, docBytes)),
  quota:
    plan === "paid" ? "a daily Cloudflare limit" : "its daily free-plan limit",
});

const INLINE = `${LIMITS.inlineBytes / 1024} KB`;
const FILE_MB = `${LIMITS.fileBytes / 1024 / 1024} MB`;

export type Section = { title: string; body: (p: PlanText) => string };

export const SECTIONS = {
  formats: {
    title: "Formats",
    body: () => `- html: a web page or a small site. Scripts run in a sandboxed iframe on a separate origin.
- markdown: rendered with code highlighting and mermaid diagrams.
- code: one source file shown with syntax highlighting; set language (for example "python").
- pdf: an uploaded PDF document.
- If format is omitted it is inferred from the entry file's extension.`,
  },
  publishing: {
    title: "Publishing",
    body: () => `- One file: publish_artifact { title, format, content }.
- Several files: publish_artifact { title, entry: "index.html", files: { "index.html": "...", "app.js": "...", "img/logo.png": { "base64": "..." } } }.
- Paths are relative, use "/" and are case-sensitive; link between files with relative URLs.
- Open outbound links with target="_blank" rel="noopener"; links can't navigate the viewer page.
- Artifacts can link to each other: use the other artifact's view URL (<origin>/a/<id>, the url publish_artifact returns, also shown by get_artifact) with target="_blank" rel="noopener". It opens in a new tab in the viewer, where live data works. Whether a visitor can open it depends on that artifact's own visibility.
- Text files are plain strings; binary files are { "base64": "..." }.
- To publish a new version, pass the artifact's id; every publish creates a version and the URL stays the same.
- Add a short message describing the change. New artifacts get the instance's default visibility (private unless an admin chose team).
- New artifacts go in your personal space. To publish into a shared space, call list_spaces and pass its id as spaceId (new artifacts only).`,
  },
  largeFiles: {
    title: "Large files",
    body: () => `- Inline content (content, text files and base64 together) is limited to ${INLINE} per call; over it, publish_artifact fails with too_large. For anything larger (up to ${FILE_MB} per file), upload each large file:
  1. create_upload { path, size, contentType, artifactId? } returns { uploadId, artifactId, url }. Omit artifactId for a new artifact and reuse the returned artifactId for every other file.
  2. PUT the raw bytes to url (valid 1 hour).
  3. publish_artifact { id: artifactId, title, entry, files: { "<path>": { "uploadId": "<uploadId>" }, ... } }; small files can stay inline next to uploaded ones.`,
  },
  reading: {
    title: "Reading",
    body: () => `- get_artifact returns metadata and, for text files up to 1 MB, the content; otherwise a downloadUrl valid for 10 minutes.
- list_artifacts, search_artifacts and list_versions page with cursor; restore_version publishes an old version again.`,
  },
  sharing: {
    title: "Sharing and visibility",
    body: () => `- private: you and the people you share with. team: every member of this instance. public: anyone with the link, no sign-in.
- share_artifact { id, email, role: "viewer" | "editor" } adds a person; unshare_artifact removes them. Editors can publish new versions.
- set_visibility { id, visibility } changes who can open it. Sharing, visibility and delete are for the owner or space manager only.
- Make an artifact public only when the user asks for it.`,
  },
  liveData: {
    title: "Live data (html artifacts)",
    body: (
      p,
    ) => `- Declare capabilities when publishing: capabilities: { db: true, viewer: true, storage: true }.
  - db: a shared document store every viewer sees, updated live.
  - viewer: the signed-in viewer's email and name.
  - storage: private per-viewer key/value storage.
- Undeclared calls fail with capability_denied. allowAnonymousWrites: true lets anonymous viewers of public artifacts write (rate-limited).
- On a public artifact that declares db, anonymous visitors' writes fail with anon_writes_disabled unless allowAnonymousWrites is true.
- Limits: ${p.dataDoc} per document on this instance (${p.plan} plan${p.dataDocNote}), ${LIMITS.artifactDataBytes / 1024 / 1024} MB per artifact, ${LIMITS.viewerWritesPerMin} writes per minute per viewer.
- The artifact_data_* tools read and write the same db collections; documents are JSON objects. They need the db capability, except for the artifact's owner, who may seed data before declaring it (viewers' pages still need db).`,
  },
  runtimeApi: {
    title: "window.openArtifacts (available inside published html)",
    body: () => `- await openArtifacts.ready
- openArtifacts.viewer.get() → { email, name } or null
- openArtifacts.db.collection(name): get(id), list({ cursor, limit }), query({ where, orderBy, order, limit }),
  set(id, data), update(id, patch), delete(id), subscribe(cb) → unsubscribe
  subscribe(cb) gets { docs, deleted, resync? }: after a reconnect it gets { docs: [], deleted: [], resync: true };
  refetch your data when resync is true.
- openArtifacts.storage: get(key), set(key, value), delete(key), list()
- openArtifacts.theme ("light" | "dark") and onTheme(cb)

Example: a live poll (publish with capabilities: { db: true, viewer: true })

\`\`\`html
<button data-choice="yes">Yes</button> <button data-choice="no">No</button> <p id="out"></p>
<script>
  const votes = openArtifacts.db.collection("votes");
  async function render() {
    const { items } = await votes.list();
    out.textContent = items.filter((d) => d.data.choice === "yes").length + " yes / " + items.length + " total";
  }
  document.querySelectorAll("button").forEach((b) => b.onclick = async () => {
    const me = await openArtifacts.viewer.get();
    await votes.set(me ? me.email.replace(/[^A-Za-z0-9_-]/g, "_") : "anon", { choice: b.dataset.choice });
  });
  openArtifacts.ready.then(render); votes.subscribe(render);
</script>
\`\`\``,
  },
  errors: {
    title: "Errors",
    body: (
      p,
    ) => `- Results with isError carry "<code>: <message>". not_found also means you lack access.
- too_large: inline content over ${INLINE} (use create_upload), a data document over ${p.dataDoc}, or a request body over ${p.mcpBody}.
- capability_denied: the artifact does not declare the capability; publish a new version with it in capabilities.
- quota_exceeded means the instance hit ${p.quota}; retry after 00:00 UTC.
- A result may carry an extra note that the instance hit its CPU limit; pass it on to the user once, since the fix (Workers Paid) is theirs.`,
  },
} satisfies Record<string, Section>;

const ORDER = [
  "formats",
  "publishing",
  "largeFiles",
  "reading",
  "sharing",
  "liveData",
  "runtimeApi",
  "errors",
] as const satisfies readonly (keyof typeof SECTIONS)[];

/** The sections in order, each as `<heading>\n<body>`, `heading` given the title. */
export const renderSections = (
  p: PlanText,
  heading: (title: string) => string,
): string =>
  ORDER.map(
    (k) => `${heading(SECTIONS[k].title)}\n${SECTIONS[k].body(p)}`,
  ).join("\n\n");

const memo = new Map<string, string>();

/**
 * The server instructions for `plan`. With `skillUrl` (the instance's
 * /skill.md, when served) they end by pointing at it.
 */
export function INSTRUCTIONS(
  plan: Plan,
  skillUrl?: string,
  docBytes: number = dataDocLimit(plan),
): string {
  const key = `${plan}|${docBytes}|${skillUrl ?? ""}`;
  let s = memo.get(key);
  if (s === undefined) {
    s = `Open Artifacts hosts the pages, documents and code you publish, with versions, sharing and live data.

${renderSections(planText(plan, docBytes), (t) => t)}
${skillUrl ? `\nFull guide: ${skillUrl}\n` : ""}`;
    memo.set(key, s);
  }
  return s;
}
