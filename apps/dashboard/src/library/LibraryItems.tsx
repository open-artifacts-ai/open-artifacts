import { type ArtifactSummary, viewerPath } from "@oa/shared";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@oa/ui/shadcn";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { artifactPermissions, useHosted } from "../auth/permissions";
import { ArtifactCard } from "./ArtifactCard";
import { ArtifactRow } from "./ArtifactRow";
import { LibraryDeleteDialog } from "./LibraryDeleteDialog";
import { GRID, LIST } from "./ui";

export function LibraryItems({
  items,
  meId,
  view,
  showSpace,
}: {
  items: ArtifactSummary[];
  meId?: string;
  view: "grid" | "list";
  showSpace: boolean;
}) {
  const hosted = useHosted();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const anchor = useRef<string | null>(null);
  const [targets, setTargets] = useState<ArtifactSummary[]>([]);
  const manageable = items.filter((a) => artifactPermissions(a, hosted).delete);
  const picked = manageable.filter((a) => selected?.has(a.id));
  function toggle(id: string, range: boolean) {
    const next = new Set(selected);
    const start = manageable.findIndex((a) => a.id === anchor.current);
    const end = manageable.findIndex((a) => a.id === id);
    const rows =
      range && start >= 0
        ? manageable.slice(Math.min(start, end), Math.max(start, end) + 1)
        : manageable.slice(end, end + 1);
    const checked = !next.has(id);
    for (const row of rows) {
      if (checked) next.add(row.id);
      else next.delete(row.id);
    }
    anchor.current = id;
    setSelected(next);
  }
  return (
    <>
      {manageable.length > 0 &&
        (selected ? (
          <fieldset
            aria-label="Selection actions"
            className="z-10 flex items-center gap-2 rounded-md border bg-card p-2 max-[600px]:fixed max-[600px]:inset-x-2 max-[600px]:bottom-[max(.5rem,env(safe-area-inset-bottom))]"
          >
            <span aria-live="polite">{picked.length} selected</span>
            <Button
              variant="destructive"
              size="sm"
              disabled={!picked.length}
              onClick={() => setTargets(picked)}
            >
              Delete
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
              Cancel
            </Button>
          </fieldset>
        ) : (
          <Button
            className="self-end"
            variant="outline"
            size="sm"
            onClick={() => {
              anchor.current = null;
              setSelected(new Set());
            }}
          >
            Select
          </Button>
        ))}
      <div
        className={
          (view === "grid" ? GRID : LIST) +
          (selected ? " max-[600px]:pb-20" : "")
        }
      >
        {items.map((a) => {
          const can = artifactPermissions(a, hosted);
          const controls = selected ? (
            <input
              key={a.id}
              type="checkbox"
              className="relative z-[1] size-5 accent-primary"
              aria-label={`Select ${a.title}`}
              disabled={!can.delete}
              checked={can.delete && selected.has(a.id)}
              onChange={(e) =>
                toggle(
                  a.id,
                  "shiftKey" in e.nativeEvent &&
                    e.nativeEvent.shiftKey === true,
                )
              }
            />
          ) : (
            (can.share || can.setVisibility || can.delete) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-8"
                    aria-label={`Actions for ${a.title}`}
                  >
                    •••
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {(can.share || can.setVisibility) && (
                    <DropdownMenuItem
                      onSelect={() =>
                        void navigate({
                          to: viewerPath(a.id),
                          search: { panel: "open", tab: "share" },
                        } as never)
                      }
                    >
                      Share…
                    </DropdownMenuItem>
                  )}
                  {can.delete && (
                    <DropdownMenuItem onSelect={() => setTargets([a])}>
                      Delete
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )
          );
          const props = { artifact: a, showSpace, controls };
          return view === "grid" ? (
            <ArtifactCard key={a.id} {...props} meId={meId} />
          ) : (
            <ArtifactRow key={a.id} {...props} />
          );
        })}
      </div>
      {targets.length > 0 && (
        <LibraryDeleteDialog
          artifacts={targets}
          onClose={() => setTargets([])}
          onDeleted={(ids) => {
            setSelected((current) => {
              if (!current) return null;
              const next = new Set(current);
              for (const id of ids) next.delete(id);
              return next.size ? next : null;
            });
          }}
        />
      )}
    </>
  );
}
