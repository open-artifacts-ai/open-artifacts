---
title: MCP tools
description: The tools every instance's MCP server exposes, and what each one takes.
order: 3
---

Tool inputs are JSON Schema. Each tool returns plain text plus structured output. Calls act as the signed-in user (or the token's owner), and an artifact you can't access is reported as not found.

## Publishing

`publish_artifact` creates an artifact, or publishes a new version when you pass `id`. Pass exactly one of `content` or `files`. To change only settings (`title`, `description`, `visibility`, `capabilities`, or `dataWriters`), pass `id` with neither: the artifact updates in place, no version is created, and `message` is ignored.

| Field | Notes |
|---|---|
| `id` | The artifact to publish a new version of, or to change settings on. Leave it out to create one, or pass an id reserved by `create_upload`. |
| `title` | Required when creating (no `id`). Up to 200 characters. |
| `description` | Optional. Up to 2,000 characters. |
| `format` | `html`, `markdown`, `code`, `pdf`, or `image`. With `content`, pass `format` or `entry`; when it's left out, it's taken from the entry file's extension (`.html`, `.md` and `.pdf`; `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp` and `.svg` are `image`; a known text file such as source code, `.txt`, `.csv`, `.tsv`, `.log`, `.env`, `.conf` or `.cfg` is `code`). Any other file publishes as `code` when it is UTF-8 text (a `LICENSE` or `.gitignore`), and otherwise, such as an archive, fails with the error code `"unsupported_format"`; so does a HEIC photo (save it as JPEG first). An `image` artifact is one file, the image. The entry's content must fit its format: `code`, `markdown` and `html` are UTF-8 text, a `pdf` starts with `%PDF`, an image starts with its extension's signature (an `.svg` is UTF-8 text with an `<svg>` root), and an uploaded image's `contentType` matches its extension; otherwise the publish fails with the error code `"binary_entry"`. |
| `content` | A single file as a string. Needs `format` or `entry`. |
| `files` | Instead of `content`: a map of path to file, for an HTML page with its CSS, JS, and images. Each file is a string, `{ "base64": "…" }` for binary, or `{ "uploadId": "…" }` from `create_upload`. |
| `entry` | The file to open first. With `files`, it defaults to `index.html`, then `README.md`, then the first file. |
| `language` | Optional, for `code`. Taken from the entry file's extension when it's left out. |
| `message` | Optional change note for this version. Up to 500 characters. |
| `spaceId` | Optional, new artifacts only. Publishes into a shared space where you're an editor or manager. Leave it out to publish to your personal space. On an existing artifact it fails with use_move; move it instead. |
| `visibility` | `private`, `team`, or `public`. A new artifact without it gets the instance's default visibility, which is `private` unless an admin changed it. |
| `capabilities` | The [runtime API](/docs/runtime-api/) features the page may use: `{ "db": true, "viewer": true, "storage": true }`. Each defaults to `false`. |
| `dataWriters` | Who can change the page's live data: `viewers` (anyone who can view it) or `editors`. Defaults to `viewers`. |
| `allowAnonymousWrites` | Deprecated; use `dataWriters`. `true` sets `viewers`; `false` on a public artifact sets `editors`. |

Only the artifact's creator can change `visibility`, `capabilities`, or `dataWriters` when publishing a new version; editors can publish the rest.

It returns the artifact's `id`, the new `version` (the current one for a settings-only update), and its view URL.

## Large files

Inline `content` and `files` are capped at {LIMIT_INLINE} in total. Send anything larger as an upload, one file at a time. A file can be up to {LIMIT_FILE}, and one publish up to {LIMIT_PUBLISH}.

1. **Reserve the upload:** call `create_upload` with the file's `path` in the artifact, its exact `size` in bytes, and optionally its `contentType` (by default, it's taken from the extension). Pass `artifactId` to add to an existing artifact you can edit; leave it out to reserve a new artifact id. It returns `uploadId`, `artifactId`, a signed `url`, and `expiresAt`, {LIMIT_UPLOAD_URL_TTL} from now.
2. **Send the bytes:** a raw `PUT` of the file to `url`, with no auth header (the URL is signed) and a `Content-Length` equal to the declared `size`. Each upload takes one PUT; it answers `204` when it's done.

   ```sh
   curl -fsS -T report.pdf "$UPLOAD_URL"
   ```

3. **Publish:** call `publish_artifact` with `id` set to the returned `artifactId`, and the file in `files` under the same path as `{ "uploadId": "…" }`. A new artifact also needs a `title`. Uploaded and inline files can be mixed in one publish.

   ```json
   {
     "id": "<artifactId>",
     "title": "Q3 report",
     "files": { "report.pdf": { "uploadId": "<uploadId>" } }
   }
   ```

An upload is used once. One that's never published is deleted by the daily cleanup once it's older than {LIMIT_UPLOAD_TTL}.

On Workers Free, an MCP request larger than {LIMIT_MCP_BODY_FREE} is refused before it's read, with a message pointing to `create_upload` (Workers Paid allows {LIMIT_MCP_BODY_PAID}). This also affects live-page data written with `artifact_data_set` or `artifact_data_update`. JSON escaping can double a quote- or backslash-heavy document, so one close to the {LIMIT_DATA_DOC_FREE} data-document limit can push the MCP request over {LIMIT_MCP_BODY_FREE}, even though the REST API accepts the same document.

## Search freshness

Search indexes each publish asynchronously, so a new version becomes searchable with `search_artifacts` within about {LIMIT_INDEX_LAG} of being published. Until then, search matches the previous version's text. Only the first {LIMIT_INDEX_TEXT} of an artifact's entry file is indexed; text past that isn't searchable. To find something you just published, use `get_artifact` or `list_artifacts`.

## Reading

- `get_artifact`: metadata plus the content of a version, the latest by default.
- `list_artifacts`: filter by owner, format, visibility, agent, or updated-since. Paginated.
- `search_artifacts`: full-text search over title, description, and extracted text. A PDF is searchable by its text once someone who can edit it has opened it in the dashboard; before that, only by title and description. An image is searchable by its title and description only.
- `list_spaces`: lists the spaces you can publish into: your personal space first, then shared spaces where you're an editor or manager. Takes no input.

## Versions

- `list_versions`: the history, with the agent and change note for each version.
- `restore_version`: restores an earlier version by publishing it as a new one.

## Sharing

- `share_artifact`: gives an email address `viewer` or `editor` access. The person doesn't need to have signed in yet.
- `unshare_artifact`: removes that access.
- `set_visibility`: `private`, `team`, or `public`.

Only an artifact's creator can share it, change its visibility, or delete it.

## Deleting

`delete_artifact` moves an artifact to the trash. It can be recovered for {LIMIT_SOFT_DELETE}, then it's purged. Restore it from Trash in the dashboard, or with `undelete_artifact`, within that time. In a shared space, its managers can restore it too.

## Live-page data

`artifact_data_get`, `artifact_data_list`, `artifact_data_query`, `artifact_data_set`, `artifact_data_update`, and `artifact_data_delete` read and write an artifact's live-page data. It's the same store the [runtime API](/docs/runtime-api/) uses, so an agent can seed a tracker or read a poll's results.

## REST API

`/api/v1/` mirrors these operations for the dashboard and for scripts, with the same tokens.
