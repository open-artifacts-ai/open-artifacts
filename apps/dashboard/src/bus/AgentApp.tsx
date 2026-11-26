// agy S6: the app an agent runs (Claude Code, Codex, Antigravity...), with its
// mark from @oa/ui, the same one the landing page shows. A kind the server
// doesn't know shows its own token with a tile of its first letter.
import { agentMark, agentMarkUrl } from "@oa/ui/agent-marks";
import { cn } from "@oa/ui/shadcn";

/** A hub-supplied token, shown as text: control characters dropped, at most 32. */
export const tidyToken = (kind: string): string =>
  [...kind]
    .filter((c) => {
      const n = c.codePointAt(0) ?? 0;
      return n > 0x1f && (n < 0x7f || n > 0x9f);
    })
    .join("")
    .trim()
    .slice(0, 32);

/** The app's name: the server's product, else the kind's own token. */
export const appName = (a: { kind: string; product?: string }): string =>
  a.product ?? (tidyToken(a.kind) || "Agent");

/**
 * The mark, named for screen readers: an image with alt, or a mono mask with
 * aria-label. Without a product of its own, a tile of the kind's first letter.
 */
export function AppMark({
  product,
  kind,
  name,
  className,
}: {
  product: string | undefined;
  /** The hub kind token, for the letter tile when the app has no mark. */
  kind?: string;
  name: string;
  className?: string;
}) {
  const m = agentMark(product, kind);
  const box = cn("inline-block size-[16px] flex-none align-[-3px]", className);
  if ("png" in m)
    return (
      <img
        data-app-mark=""
        src={m.png}
        alt={name}
        className={cn(box, "rounded-[3px] border border-border")}
      />
    );
  if (m.mono) {
    // Drawn in the text colour, so it reads in light and dark.
    const url = `url("${agentMarkUrl(m)}")`;
    return (
      <span
        data-app-mark=""
        role="img"
        aria-label={name}
        className={cn(box, "bg-current")}
        style={{
          maskImage: url,
          WebkitMaskImage: url,
          maskSize: "contain",
          WebkitMaskSize: "contain",
          maskRepeat: "no-repeat",
          WebkitMaskRepeat: "no-repeat",
          maskPosition: "center",
          WebkitMaskPosition: "center",
        }}
      />
    );
  }
  return (
    <img data-app-mark="" src={agentMarkUrl(m)} alt={name} className={box} />
  );
}

/** Mark plus app name, as a row shows it. */
export function AgentApp({ a }: { a: { kind: string; product?: string } }) {
  const name = appName(a);
  return (
    <span className="inline-flex min-w-0 items-center gap-[6px]">
      <AppMark product={a.product} kind={a.kind} name={name} />
      <span className="truncate" aria-hidden="true">
        {name}
      </span>
    </span>
  );
}
