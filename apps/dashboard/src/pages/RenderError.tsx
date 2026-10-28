import { useDocumentTitle } from "../layout/useDocumentTitle";
import { EdgePanel } from "./Edge";

/**
 * A page that threw while rendering (the router's defaultErrorComponent): it
 * shows in the layout's outlet, so the sidebar and header stay usable.
 */
export function RenderError() {
  useDocumentTitle("Something went wrong");
  return (
    <EdgePanel>
      <h1>Something went wrong</h1>
      <p>This page couldn't be shown. Reload to try again.</p>
      <div className="oa-actions">
        <button
          type="button"
          className="oa-btn oa-primary"
          onClick={() => location.reload()}
        >
          Reload
        </button>
        <a className="oa-btn" href="/">
          Go to library
        </a>
      </div>
    </EdgePanel>
  );
}
