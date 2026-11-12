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
    className="flex size-5 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-[9px] font-medium text-foreground"
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
  const { gone, confirm, setConfirm, back, run } = rm;
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
  // Every agent of the thread, removed ones too (#2174), in the server's order.
  // A viewer who cannot reply sees them but no × (the outsider rule alone decides who sees agents).
  const list = member ? (t.agents ?? []) : [];
  const isOff = (a: ThreadAgent) => a.removed === true || a.key === gone?.key;
  const mayRemove = (a: ThreadAgent) => a.canRemove && api.canComment;
  const n = people.length + list.length;

  // The list never grows past the thread card it floats over.
  useLayoutEffect(() => {
    if (!open) return;
    const card = box.current?.closest("[data-thread]");
    if (card) setRoom(card.clientWidth - 24);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      // A target the render already removed (the confirm's Remove) was inside.
      const t = e.target as Node;
      if (t.isConnected && !box.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("pointerdown", down);
    return () => document.removeEventListener("pointerdown", down);
  }, [open]);
  useEffect(() => () => clearTimeout(timer.current), []);
  // The confirm closing takes the focused Remove with it; keep focus in the group so it stays open.
  const asked = useRef(false);
  useEffect(() => {
    const was = asked.current;
    asked.current = confirm !== null;
    if (!was || confirm !== null || !open) return;
    if (box.current?.contains(document.activeElement)) return;
    quiet.current = true;
    trigger.current?.focus({ preventScroll: true });
    quiet.current = false;
  }, [confirm, open]);
  if (n === 0) return null;

  // 20px faces overlapping by 3px, each ringed in the card's colour; the first
  // sits on top so every face shows its full initials or mark.
  const faces = [
    ...people.map((p) => ({
      key: `p-${p.id ?? p.name}`,
      round: true,
      el: <Person a={p} />,
    })),
    ...list.map((a) => ({
      key: a.key,
      round: false,
      el: <PartyFace p={a} medium />,
    })),
  ]
    .slice(0, SHOWN)
    .map((f, i, all) => (
      <span
        key={f.key}
        data-face=""
        style={{ zIndex: all.length - i, marginLeft: i === 0 ? 0 : -3 }}
        className={`relative inline-flex shrink-0 bg-card ring-[1.5px] ring-card ${f.round ? "rounded-full" : "rounded-md"}`}
      >
        {f.el}
      </span>
    ));
  const names = [
    `${people.length} ${people.length === 1 ? "person" : "people"}`,
    ...(member
      ? [`${list.length} ${list.length === 1 ? "agent" : "agents"}`]
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
        // A focused button that leaves the list (Remove, once confirmed) blurs with no target; focus did not go elsewhere.
        if (asking.current || !e.currentTarget.isConnected) return;
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
        <span aria-hidden="true" className="flex items-center">
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
          {list.length > 0 && (
            <>
              <h4 className={`m-0 mt-1 ${TXT} font-semibold ${MUTED}`}>
                Agents
              </h4>
              {list.map((a) => {
                const off = isOff(a);
                return (
                  <div
                    key={a.key}
                    data-participant-agent={a.key}
                    data-off={off ? "" : undefined}
                    className={`flex items-center gap-2 ${TXT}`}
                  >
                    <PartyFace p={a} />
                    <span
                      className={`min-w-0 truncate ${off ? `line-through ${MUTED}` : ""}`}
                    >
                      {a.name}
                    </span>
                    <span className={`ml-auto whitespace-nowrap ${MUTED}`}>
                      {off ? "Not notified" : "Gets replies"}
                    </span>
                    {!mayRemove(a) && a.canRemove === false && (
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
                    {mayRemove(a) && !off && (
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
                    {mayRemove(a) && off && (
                      <button
                        type="button"
                        data-add-back=""
                        aria-label={`Notify ${a.name} in this thread again`}
                        className="cursor-pointer whitespace-nowrap rounded-md border-0 bg-transparent p-0 px-1 text-[length:var(--oa-text-xs)] text-[var(--oa-accent-fg)] underline"
                        onClick={() => run(a, false)}
                      >
                        Add back
                      </button>
                    )}
                  </div>
                );
              })}
            </>
          )}
          <RemovalNotices rm={rm} api={api} />
        </div>
      )}
    </div>
  );
}
