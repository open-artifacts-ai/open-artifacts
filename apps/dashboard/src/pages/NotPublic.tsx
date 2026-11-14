import { viewerPath } from "@oa/shared";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { EdgePanel } from "./Edge";

/** What a framed shell shows for anything it can't render anonymously:
    a private or missing artifact, or any route but /a/<id>/full. Never a
    login form, and the copy never says whether the artifact exists. */
export function NotPublic({ id }: { id?: string }) {
  useDocumentTitle("Restricted");
  return (
    <EdgePanel>
      <h1>This artifact is restricted</h1>
      <p>Open it in Open Artifacts to log in and view it.</p>
      <div className="oa-actions">
        <a
          className="oa-btn oa-primary"
          href={id ? viewerPath(id) : "/"}
          target="_blank"
          rel="noopener"
        >
          Open in Open Artifacts <span aria-hidden="true">↗</span>
        </a>
      </div>
    </EdgePanel>
  );
}
