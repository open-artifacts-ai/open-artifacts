import type { PresenceEntry } from "@oa/shared";
import { PresenceAvatar, presenceName } from "./PresenceAvatar";

/** An agent's second line: "<Owner>'s agent · Viewing" or "· Editing". */
export const agentLine = (e: PresenceEntry) =>
  e.agent
    ? `${e.agent.owner}'s agent · ${e.agent.state === "editing" ? "Editing" : "Viewing"}`
    : null;

/** The click card (3A): a name; an agent adds owner, state and its own words. Never an email. */
export function PresenceCard({ entry }: { entry: PresenceEntry }) {
  const line = agentLine(entry);
  const note = entry.agent?.activity;
  return (
    <div className="flex items-start gap-3">
      <PresenceAvatar entry={entry} size={40} aria-hidden="true" />
      <div className="flex min-w-0 flex-col gap-1">
        <div className="break-words text-sm font-semibold leading-tight text-foreground">
          {presenceName(entry)}
        </div>
        {line && (
          <div className="text-xs leading-tight text-muted-foreground">
            {line}
          </div>
        )}
        {note && (
          <>
            <div className="break-words text-[13px] leading-snug text-foreground">
              {`“${note}”`}
            </div>
            <div className="text-[11px] leading-tight text-muted-foreground">
              In the agent's own words
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** One row of the "+N" list. */
export function PresenceRow({ entry }: { entry: PresenceEntry }) {
  const line = agentLine(entry);
  return (
    <div className="flex items-center gap-2.5 rounded-md px-1 py-1.5">
      <PresenceAvatar entry={entry} size={28} aria-hidden="true" />
      <div className="min-w-0">
        <div className="break-words text-[13.5px] font-medium leading-tight">
          {presenceName(entry)}
        </div>
        {line && (
          <div className="text-xs leading-tight text-muted-foreground">
            {line}
          </div>
        )}
      </div>
    </div>
  );
}
