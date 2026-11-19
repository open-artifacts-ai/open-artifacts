// #2610 part 2: the box for a new thread (a plain note, a comment on selected
// text, a pin) shows the page's agent it will notify, before posting.
// Removing it sends `notifyPageAgent: false`: the thread notifies no agent
// unless one is @-mentioned. No chip without a pageAgent (a page a person
// published, a gone agent), for guests and outsiders, or on replies.
import { X } from "lucide-react";
import { useState } from "react";
import { firstOf, NOTIFY, optOut, type PageAgent } from "../../api/pageAgent";
import { useArtifact } from "../../api/queries";
import { TXT } from "../ui";
import { AuthorFace } from "./AuthorFace";
import { CHIP, Tip } from "./threadAgents";
import type { CommentsApi } from "./useComments";

/** The chip's state for one new-thread box. */
export function usePageAgentChip(api: CommentsApi) {
  const art = useArtifact(api.artifactId).data;
  const agent: PageAgent | null =
    api.guest || api.outsider ? null : (art?.pageAgent ?? null);
  const [on, setOn] = useState(true);
  return {
    /** The agent the chip shows, or null (none, or removed). */
    shown: agent && on ? agent : null,
    remove: () => setOn(false),
    /** After a post: the next thread starts with the chip again. */
    reset: () => setOn(true),
    /**
     * What the new thread's body adds. With an agent @mentioned the server adds
     * no page agent, so nothing is sent; else the opt-out, when the chip was removed.
     */
    bodyFor: (x?: { mentions: readonly unknown[] }) =>
      agent && !(x && x.mentions.length > 0) ? optOut(on) : {},
  };
}

/** "Notifying" and the chip: face, name (a teammate's says whose), and ×. */
export function NotifyChip({
  agent,
  onRemove,
}: {
  agent: PageAgent;
  onRemove: () => void;
}) {
  // A teammate's agent says whose it is; the caller's own is just its name.
  const label = !agent.me
    ? NOTIFY.teammate(agent.name, firstOf(agent.for))
    : agent.name;
  const stop = NOTIFY.stop(agent.name);
  return (
    <span
      data-notify-chip={agent.key}
      className={`flex min-w-0 items-center gap-1.5 ${TXT} text-muted-foreground`}
    >
      <span className="shrink-0">{NOTIFY.lead}</span>
      <span className={`${CHIP} min-w-0 pr-0.5`}>
        <AuthorFace
          small
          a={{ kind: "agent", name: agent.name, linked: false, me: false }}
        />
        <span className="truncate">{label}</span>
        <Tip text={stop}>
          <button
            type="button"
            aria-label={`Stop notifying ${agent.name}`}
            className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 leading-none text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onRemove}
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        </Tip>
      </span>
    </span>
  );
}
