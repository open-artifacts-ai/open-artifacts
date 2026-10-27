import type { McpServer } from "@modelcontextprotocol/server";
import {
  type ArtifactSummary,
  type GetArtifactResult,
  viewerPath,
} from "@oa/shared";
import {
  type ContentViewer,
  contentViewer,
  signDownload,
} from "../../content/signing.js";
import type { Env } from "../../env.js";
import { ApiError, appOrigin, contentOrigin } from "../../http/errors.js";
import {
  getSummary,
  isSettingsOnly,
  list,
  listVersions,
  patch,
  publish,
  publishSettings,
  readVersionFile,
  restoreVersion,
  softDelete,
} from "../../services/artifacts.js";
import { search } from "../../services/search.js";
import { deleteShare, putShare } from "../../services/shares.js";
import { publishableSpaces } from "../../services/spaces.js";
import { createUpload } from "../../services/uploads.js";
import { guard, ok, type ToolEnv } from "../server.js";
import { toolConfig } from "../tool-defs.js";

/** get_artifact inlines text files up to this size. */
export const INLINE_TEXT_BYTES = 1024 * 1024;

const TEXT_TYPE =
  /^(text\/|application\/(json|javascript|ecmascript|xml|x-yaml|yaml|toml|x-sh|sql|graphql)\b|image\/svg\+xml\b|[a-z]+\/[\w.-]+\+(json|xml)\b)/i;
export const isTextType = (ct: string) => TEXT_TYPE.test(ct);

const notFound = () => new ApiError("not_found", "Not found");
const viewUrl = (env: Env, id: string) => appOrigin(env) + viewerPath(id);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const more = (cursor: string | null) => (cursor ? " (more: pass cursor)" : "");

/**
 * Content-host download URL for one file, signed for 10 minutes: an explicit
 * download (attachment), so a browser that opens it saves the file rather
 * than rendering it. Bound to `viewer` when content_revocation is on (P3 T11).
 */
async function downloadUrl(
  env: Env,
  a: ArtifactSummary,
  v: number,
  path: string,
  viewer: ContentViewer | null,
): Promise<string> {
  const { path: p } = await signDownload(
    env,
    a.id,
    v,
    path,
    Date.now(),
    viewer,
  );
  return `${contentOrigin(env)}${p}`;
}

export function registerArtifactTools(server: McpServer, t: ToolEnv): void {
  const { env, user, caller } = t;

  server.registerTool(
    "publish_artifact",
    toolConfig("publish_artifact"),
    (input) =>
      guard(async () => {
        // An id with neither content nor files: settings only, no version (#681 D).
        if (isSettingsOnly(input)) {
          const r = await publishSettings(env, user, input, t.exec);
          const line = `Updated the settings of ${r.id} in place (still v${r.version}, no new version): ${r.url}`;
          return ok(r.warning ? `${line} Warning: ${r.warning}` : line, r);
        }
        const r = await publish(env, user, input, t.agentNow(), t.exec, "any");
        const line = `Published ${input.title ? `"${input.title}" ` : ""}${r.id} v${r.version}: ${r.url}`;
        return ok(r.warning ? `${line} Warning: ${r.warning}` : line, r);
      }),
  );

  server.registerTool("create_upload", toolConfig("create_upload"), (input) =>
    guard(async () => {
      const r = await createUpload(env, user, input);
      return ok(
        `Upload ${r.uploadId} reserved for artifact ${r.artifactId}: PUT the bytes to ${r.url} before ${r.expiresAt}`,
        r,
      );
    }),
  );

  server.registerTool("get_artifact", toolConfig("get_artifact"), (input) =>
    guard(async () => {
      const artifact = await getSummary(env, caller, input.id);
      const v = input.version ?? artifact.currentVersion;
      const [version] = await listVersions(env, caller, input.id, v + 1);
      if (!version || version.version !== v) throw notFound();
      const path = input.path ?? version.entry;
      const file = version.files.find((f) => f.path === path);
      if (!file) throw notFound();
      const out: GetArtifactResult = { artifact, version };
      if (
        input.includeContent &&
        isTextType(file.contentType) &&
        file.size <= INLINE_TEXT_BYTES
      ) {
        const { body } = await readVersionFile(env, caller, input.id, v, path);
        out.content = await body.text();
      } else {
        out.downloadUrl = await downloadUrl(
          env,
          artifact,
          v,
          path,
          contentViewer(env, user.id, t.sessionEpoch),
        );
      }
      const what =
        out.content !== undefined
          ? `${path} inline`
          : `${path} at downloadUrl (10 min)`;
      return ok(
        `"${artifact.title}" ${artifact.format} v${v}, ${what}: ${viewUrl(env, artifact.id)}`,
        out,
      );
    }),
  );

  server.registerTool("list_artifacts", toolConfig("list_artifacts"), (input) =>
    guard(async () => {
      const page = await list(env, caller, input);
      return ok(
        `${plural(page.items.length, "artifact")}${more(page.nextCursor)}: ${appOrigin(env)}/`,
        page,
      );
    }),
  );

  server.registerTool(
    "search_artifacts",
    toolConfig("search_artifacts"),
    (input) =>
      guard(async () => {
        const page = await search(
          env,
          caller,
          input.q,
          input.cursor,
          input.limit,
          input.spaceId,
        );
        return ok(
          `${plural(page.items.length, "match")}${more(page.nextCursor)}: ${appOrigin(env)}/search?q=${encodeURIComponent(input.q)}`,
          page,
        );
      }),
  );

  server.registerTool("list_versions", toolConfig("list_versions"), (input) =>
    guard(async () => {
      const items = await listVersions(env, caller, input.id);
      return ok(
        `${plural(items.length, "version")} of ${input.id}: ${viewUrl(env, input.id)}`,
        { items },
      );
    }),
  );

  server.registerTool(
    "restore_version",
    toolConfig("restore_version"),
    (input) =>
      guard(async () => {
        const r = await restoreVersion(
          env,
          user,
          input.id,
          input.version,
          t.agentNow(),
          t.exec,
        );
        return ok(
          `Restored v${input.version} of ${r.id} as v${r.version}: ${r.url}`,
          r,
        );
      }),
  );

  server.registerTool("share_artifact", toolConfig("share_artifact"), (input) =>
    guard(async () => {
      const s = await putShare(env, user, input.id, input, t.exec);
      return ok(
        `Shared ${input.id} with ${s.email} as ${s.role}: ${viewUrl(env, input.id)}. ${
          s.emailed ? `Emailed ${s.email} a link.` : "No email sent."
        }`,
        s,
      );
    }),
  );

  server.registerTool(
    "unshare_artifact",
    toolConfig("unshare_artifact"),
    (input) =>
      guard(async () => {
        await deleteShare(env, user, input.id, input.email);
        return ok(
          `Removed ${input.email}'s share of ${input.id}: ${viewUrl(env, input.id)}`,
          { id: input.id, email: input.email, removed: true },
        );
      }),
  );

  server.registerTool("set_visibility", toolConfig("set_visibility"), (input) =>
    guard(async () => {
      const { id: _, ...p } = input;
      const a = await patch(env, user, input.id, p);
      const line = `${a.id} is now ${a.visibility}: ${viewUrl(env, a.id)}`;
      return ok(a.warning ? `${line} Warning: ${a.warning}` : line, a);
    }),
  );

  server.registerTool("list_spaces", toolConfig("list_spaces"), () =>
    guard(async () => {
      const items = await publishableSpaces(env, caller);
      return ok(
        `${plural(items.length, "space")} you can publish into: ${appOrigin(env)}/`,
        { items },
      );
    }),
  );

  server.registerTool(
    "delete_artifact",
    toolConfig("delete_artifact"),
    (input) =>
      guard(async () => {
        await softDelete(env, user, input.id);
        return ok(
          `Deleted ${input.id}; restore it from the dashboard within 30 days: ${appOrigin(env)}/`,
          { id: input.id, deleted: true },
        );
      }),
  );
}
