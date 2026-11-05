import { Button } from "@oa/ui/shadcn";
import { RetryIcon } from "./SlowNotice";

/** The loader fades in only if the artifact isn't ready after this long. */
export const LOADER_DELAY_MS = 300;
/** Not loaded after this long: the loader becomes the timeout message. */
export const LOAD_TIMEOUT_MS = 10_000;

/**
 * The frame area's loading state (#693, Design option A): a 2px accent
 * hairline across the top edge, then "Taking longer than usual" with Retry.
 * `show` fades the hairline in and out; it stays mounted so it can fade.
 */
export function FrameLoader({
  show,
  timedOut,
  embed,
  onRetry,
}: {
  show: boolean;
  timedOut: boolean;
  /** Embedded in another page: smaller type. */
  embed: boolean;
  onRetry: () => void;
}) {
  if (timedOut)
    return (
      <div
        className="oa-vtimeout"
        data-embed={embed ? "" : undefined}
        role="alert"
      >
        <div className="oa-vtimeout-box">
          <h2 className="oa-vtimeout-h">Taking longer than usual</h2>
          <p className="oa-vtimeout-p">
            This artifact hasn't finished loading.
          </p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            {RetryIcon}
            Retry
          </Button>
        </div>
      </div>
    );
  return (
    <div
      className="oa-vloader"
      data-on={show ? "" : undefined}
      role="progressbar"
      aria-label="Loading artifact"
      aria-hidden={show ? undefined : true}
    />
  );
}
