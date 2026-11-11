// The doc format (#1100) at the data layer. A doc is stored as one Markdown
// file (DOC_ENTRY) with format "markdown" and artifacts.doc = 1 (migration
// 0033); the API reports format "doc". Until the doc room and editor land,
// the viewer shows the stored Markdown as a markdown artifact.
//
// The rules (design "Other fields"): a doc is one file, so files, entry,
// language, capabilities and dataWriters are refused with the next step; a
// doc's versions are all docs, and other artifacts never become docs; a
// whole-content publish (content, files or edits) to an existing doc is
// use_edit_doc, so a rewrite never erases what people typed.
import {
  type ArtifactPatch,
  DOC_ENTRY,
  DOCS_DISABLED_MESSAGE,
  type Format,
  type PublishInput,
} from "@oa/shared";
import { ApiError } from "../http/errors.js";

const bad = (path: string, reason: string, message: string) =>
  new ApiError("bad_request", message, { path, reason });

/** The format the API reports for a stored row. */
export const apiFormat = (format: string, doc: number): Format =>
  doc === 1 ? "doc" : (format as Format);

/** A doc's sharing fields that don't apply (patch and publish): 400 with the next step. */
export function refuseDocSettings(
  p: Pick<
    ArtifactPatch,
    "capabilities" | "dataWriters" | "allowAnonymousWrites"
  >,
): void {
  if (p.capabilities !== undefined)
    throw bad(
      "capabilities",
      "doc_capabilities",
      "A doc has no capabilities: live data, viewer identity and storage are for html artifacts. Leave capabilities out, or publish html to use them.",
    );
  for (const k of ["dataWriters", "allowAnonymousWrites"] as const)
    if (p[k] !== undefined)
      throw bad(
        k,
        "doc_data_writers",
        `A doc has no live data, so ${k} doesn't apply. Leave ${k} out: who may edit a doc follows its sharing (owners and editors edit).`,
      );
}

/**
 * A new doc's input as a markdown publish: the Markdown `content` (empty when
 * absent) as DOC_ENTRY. files, entry and language are refused, as are
 * capabilities and dataWriters.
 */
export function docPlanInput(input: PublishInput): PublishInput {
  if (input.files !== undefined)
    throw bad(
      "files",
      "doc_one_file",
      'A doc is one Markdown file. Pass its text as content with format "doc", and leave files out.',
    );
  for (const k of ["entry", "language"] as const)
    if (input[k] !== undefined)
      throw bad(
        k,
        `doc_${k}`,
        `A doc has no ${k}: it is one Markdown file. Leave ${k} out and pass the Markdown as content.`,
      );
  refuseDocSettings(input);
  return {
    ...input,
    format: "markdown",
    entry: DOC_ENTRY,
    content: input.content ?? "",
  };
}

/** A publish with content, files or edits to an existing doc: 400 use_edit_doc. */
export const useEditDoc = () =>
  new ApiError(
    "use_edit_doc",
    "This artifact is a doc: change it with edit_doc { id, ops } (small anchored operations), not a whole-content publish, which would erase what people typed. To change only its title, description, visibility or comments, pass id with those and no content.",
    { path: "id", reason: "use_edit_doc" },
  );

/** format "doc" with the id of an artifact that isn't one: 400. */
export const notConvertible = () =>
  bad(
    "format",
    "doc_conversion",
    "Other artifacts never become docs. Leave id out to create a new doc from this Markdown, or publish this artifact in its own format.",
  );

/** Creating a doc where DOCS_ENABLED is off: 400 docs_disabled. */
export const docsDisabled = () =>
  new ApiError("docs_disabled", DOCS_DISABLED_MESSAGE, {
    path: "format",
    reason: "docs_disabled",
  });
