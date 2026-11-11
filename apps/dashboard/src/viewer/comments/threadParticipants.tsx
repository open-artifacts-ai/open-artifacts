import type { CommentAuthor, CommentThread, ThreadAgent } from "@oa/shared";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { TXT } from "../ui";
import { AuthorFace, initials, PartyFace } from "./AuthorFace";
import { RemovalNotices, Tip, useAgentRemoval } from "./threadAgents";
import type { CommentsApi } from "./useComments";

const MUTED = "text-muted-foreground";
const SHOWN = 3;

/** #2174: the people in a thread, once each, in the order they first spoke. */
function peopleOf(t: CommentThread): CommentAuthor[] {
  const seen = new Set<string>();
  const out: CommentAuthor[] = [];
  for (const c of t.comments) {
    if (c.author.kind === "agent") continue;
    const id = c.author.id ?? c.author.name;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(c.author);
  }
  return out;
}

const Person = ({ a }: { a: CommentAuthor }) => (
  <span
    aria-hidden="true"
    data-avatar=""
    className="flex size-5 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-[9px] ring-2 ring-background font-medium text-foreground"
  >
    {initials(a.name)}
  </span>
);

/**
 * #2174: who is in this thread, at its top right. People are circles, agents
 * are tiles, then a count. Pointing at it, tapping it or focusing it with the
 * keyboard opens a list over the thread (nothing below moves): every person
 * and agent, which agents get replies, and an × where the caller may stop
 * notifying one. Guests and signed-out visitors see people only (#2004).
 */
export function ThreadParticipants({
  t,
  api,
}: {
  t: CommentThread;
  api: CommentsApi;
}) {
  const rm = useAgentRemoval(t, api);
  const { agents, gone, confirm, setConfirm, back } = rm;
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pointer = useRef(false);
  const quiet = useRef(false);
  const [room, setRoom] = useState<number | undefined>(undefined);
  const asking = useRef(false);
  asking.current = confirm !== null;
  const mouse = useRef(false);
  const id = useId();
  const member = !api.guest && t.agents !== undefined;
  const people = peopleOf(t);
  // Agents the list names: the live ones, then the one just removed.
  const live = member ? agents : [];
  const off: ThreadAgent[] = member && gone ? [gone] : [];
  const n = people.length + live.length + off.length;

  // The list never grows past the thread card it floats over.
  useLayoutEffect(() => {
    if (!open) return;
    const card = box.current?.closest("[data-thread]");
    if (card) setRoom(card.clientWidth - 24);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", down);
    return () => document.removeEventListener("pointerdown", down);
  }, [open]);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (n === 0) return null;

  const faces: React.ReactNode[] = [
    ...people.map((p) => <Person key={`p-${p.id ?? p.name}`} a={p} />),
    ...[...live, ...off].map((a) => (
      <span key={a.key} className="rounded-md ring-2 ring-background">
        <PartyFace p={a} medium />
      </span>
    )),
  ].slice(0, SHOWN);
  const names = [
    `${people.length} ${people.length === 1 ? "person" : "people"}`,
    ...(member
      ? [
          `${live.length + off.length} ${live.length + off.length === 1 ? "agent" : "agents"}`,
        ]
      : []),
  ].join(" and ");
  const leave = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!box.current?.contains(document.activeElement) && !asking.current) {
        setOpen(false);
      }
    }, 150);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover and focus-out handling for the button's popover
    <div
      ref={box}
      data-thread-participants=""
      className="relative shrink-0"
      onPointerEnter={(e) => {
        mouse.current = e.pointerType === "mouse";
        if (!mouse.current) return;
        clearTimeout(timer.current);
        setOpen(true);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === "mouse") leave();
      }}
      onBlur={(e) => {
        if (!box.current?.contains(e.relatedTarget as Node | null))
          setOpen(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
          quiet.current = true;
          trigger.current?.focus({ preventScroll: true });
          quiet.current = false;
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        data-participants-trigger=""
        aria-expanded={open}
        aria-controls={id}
        aria-label={`${names} in this thread`}
        className={`inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-background py-0 pr-2 pl-0.5 ${TXT} ${MUTED} hover:border-ring focus-visible:outline-2 focus-visible:outline-[var(--oa-focus)]`}
        onPointerDown={() => {
          pointer.current = true;
        }}
        // Keyboard focus opens it; a pointer press is handled by the click.
        onFocus={() => {
          if (!pointer.current && !quiet.current) setOpen(true);
        }}
        onClick={() => {
          pointer.current = false;
          setOpen((o) => (mouse.current ? true : !o));
        }}
      >
        <span aria-hidden="true" className="flex items-center -space-x-1.5">
          {faces}
        </span>
        <span data-participants-count="">
          {n > SHOWN ? `+${n - SHOWN}` : n}
        </span>
      </button>
      {open && (
        <div
          id={id}
          data-participants-list=""
          style={room && room > 0 ? { maxWidth: room } : undefined}
          className="absolute top-[calc(100%+6px)] right-0 z-20 before:absolute before:inset-x-0 before:-top-1.5 before:h-1.5 before:content-[''] flex w-[20.6rem] flex-col gap-1 rounded-lg border border-border bg-popover p-2.5 text-popover-foreground shadow-md"
        >
          {people.length > 0 && (
            <>
              <h4 className={`m-0 ${TXT} font-semibold ${MUTED}`}>People</h4>
              {people.map((p) => (
                <div
                  key={p.id ?? p.name}
                  data-person=""
                  className={`flex items-center gap-2 ${TXT}`}
                >
                  <AuthorFace a={p} />
                  <span className="min-w-0 truncate">{p.name}</span>
                </div>
              ))}
            </>
          )}
          {live.length + off.length > 0 && (
            <>
              <h4 className={`m-0 mt-1 ${TXT} font-semibold ${MUTED}`}>
                Agents
              </h4>
              {live.map((a) => (
                <div
                  key={a.key}
                  data-participant-agent={a.key}
                  className={`flex items-center gap-2 ${TXT}`}
                >
                  <PartyFace p={a} />
                  <span className="min-w-0 truncate">{a.name}</span>
                  <span className={`ml-auto whitespace-nowrap ${MUTED}`}>
                    Gets replies
                  </span>
                  {!a.canRemove && (
                    <Tip
                      text={`Only ${a.for ?? "the person"}, whose agent it is, or the artifact's owner can remove it.`}
                    >
                      <button
                        type="button"
                        data-view-only=""
                        className="cursor-help whitespace-nowrap rounded-full border border-border px-1.5 text-[length:var(--oa-text-xs)] text-muted-foreground"
                      >
                        {a.for
                          ? `${a.for.split(" ")[0]}'s agent`
                          : "Another agent"}
                      </button>
                    </Tip>
                  )}
                  {a.canRemove && (
                    <button
                      type="button"
                      aria-label={`Stop notifying ${a.name} in this thread`}
                      title={`Stop notifying ${a.name} in this thread`}
                      className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-muted-foreground hover:bg-muted hover:text-foreground"
                      onClick={(e) => {
                        back.current = e.currentTarget;
                        setConfirm(a);
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
              {off.map((a) => (
                <div
                  key={a.key}
                  data-participant-agent={a.key}
                  data-off=""
                  className={`flex items-center gap-2 ${TXT}`}
                >
                  <PartyFace p={a} />
                  <span className={`min-w-0 truncate line-through ${MUTED}`}>
                    {a.name}
                  </span>
                  <span className={`ml-auto whitespace-nowrap ${MUTED}`}>
                    Not notified
                  </span>
                </div>
              ))}
            </>
          )}
          <RemovalNotices rm={rm} api={api} />
        </div>
      )}
    </div>
  );
}
