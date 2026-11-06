import type { ArtifactSummary } from "@oa/shared";
import { FormatIcon } from "@oa/ui";
import { UserAvatar } from "../layout/UserAvatar";
import { SpaceMarker, VisibilityWithHint } from "../spaces/SpaceMarker";
import { AppLink } from "./AppLink";
import { AsksBadge } from "./AsksBadge";
import { relativeTime } from "./time";
import { META, STRETCH, TITLE_LINK } from "./ui";

export type CardProps = {
  artifact: ArtifactSummary;
  meId?: string;
  /** The cross-space Library: show which space each artifact is in. */
  showSpace?: boolean;
};

function Meta({ artifact: a, meId, showSpace }: CardProps) {
  return (
    <div
      className={`flex flex-wrap items-center gap-[var(--oa-space-2)] ${META}`}
    >
      <FormatIcon format={a.format} size={14} />
      <VisibilityWithHint visibility={a.visibility} space={a.space} />
      {showSpace && <SpaceMarker space={a.space} />}
      <AsksBadge n={a.asksForYou} />
      {a.lastAgent && <span>{a.lastAgent.name}</span>}
      {a.owner.id !== meId && (
        <UserAvatar
          name={a.owner.name ?? undefined}
          email={a.owner.email ?? a.owner.name ?? "Unknown"}
        />
      )}
      <time dateTime={a.updatedAt}>{relativeTime(a.updatedAt)}</time>
    </div>
  );
}

/** Lifts 1px with the stronger shadow on hover and keyboard focus; presses
    back down. The 1px edge is the ring in --oa-shadow-1/-2. */
const CARD = `lib-card ${STRETCH} flex flex-col gap-[var(--oa-space-2)] rounded-lg bg-card p-[var(--oa-space-3)] text-card-foreground shadow-[var(--oa-shadow-1)] transition-[box-shadow,transform] duration-(--oa-duration-fast) ease-(--oa-ease) hover:-translate-y-px hover:shadow-[var(--oa-shadow-2)] has-[a:focus-visible]:-translate-y-px has-[a:focus-visible]:shadow-[var(--oa-shadow-2)] has-[a:focus-visible]:outline-offset-2 active:translate-y-0 active:bg-[var(--oa-surface-2)] active:shadow-[var(--oa-shadow-1)] motion-reduce:hover:translate-y-0 motion-reduce:has-[a:focus-visible]:translate-y-0`;

export function ArtifactCard(p: CardProps) {
  const a = p.artifact;
  return (
    <article className={CARD}>
      {/* The format tile is always there; a thumbnail covers it, so a missing,
          broken or blank one never leaves an empty block. 4:3 on phones. */}
      <div className="lib-thumb relative aspect-[16/10] overflow-hidden rounded-md bg-background max-[600px]:aspect-[4/3]">
        <div
          className="flex h-full flex-col gap-[var(--oa-space-2)] overflow-hidden p-[var(--oa-space-3)] text-muted-foreground"
          aria-hidden={a.thumbnailUrl ? true : undefined}
        >
          <FormatIcon format={a.format} size={20} decorative />
          <span className="line-clamp-3 text-[length:var(--oa-text-md)] leading-[1.3] font-semibold [overflow-wrap:anywhere] text-foreground">
            {a.title}
          </span>
        </div>
        {a.thumbnailUrl && (
          <img
            src={a.thumbnailUrl}
            alt=""
            loading="lazy"
            className="absolute inset-0 block size-full object-cover"
            onError={(e) => {
              e.currentTarget.hidden = true;
            }}
          />
        )}
      </div>
      <h3 className="text-[length:var(--oa-text-sm)] font-semibold max-[600px]:line-clamp-2">
        <AppLink className={TITLE_LINK} href={`/a/${a.id}`}>
          {a.title}
        </AppLink>
      </h3>
      <Meta {...p} />
    </article>
  );
}
