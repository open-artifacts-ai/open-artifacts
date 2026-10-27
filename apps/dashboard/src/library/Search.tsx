import { Skeleton } from "@oa/ui/shadcn";
import { useSearch as useRouteSearch } from "@tanstack/react-router";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { ArtifactRow } from "./ArtifactRow";
import { SearchIcon } from "./icons";
import { ALERT, Empty, H1, LIST, PAGE } from "./ui";
import { uniqueItems, useSentinel } from "./useInfinite";
import { useSearchQuery } from "./useSearchQuery";

export function SearchPage() {
  useDocumentTitle("Search");
  const raw = useRouteSearch({ strict: false }) as { q?: string };
  const q = (raw.q ?? "").trim();
  const r = useSearchQuery(q);
  const sentinel = useSentinel(r);
  const items = uniqueItems(r.data?.pages);
  return (
    <section className={PAGE}>
      <h1 className={H1}>Search</h1>
      {!q && (
        <Empty
          icon={<SearchIcon />}
          title="Search your artifacts"
          description="Type in the search box to find artifacts by title, description or content."
        />
      )}
      {r.isError && (
        <div className={ALERT} role="alert">
          Search failed. Try again.
        </div>
      )}
      {q && r.isPending && !r.isError && (
        <div className={LIST} role="status" aria-label="Searching">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      )}
      {r.isSuccess && items.length === 0 && (
        <Empty
          icon={<SearchIcon />}
          title={`No results for “${q}”`}
          description="Try different words, or check the spelling."
        />
      )}
      {r.isSuccess && items.length > 0 && (
        <p
          className="text-[length:var(--oa-text-sm)] text-muted-foreground"
          aria-live="polite"
        >
          {items.length}
          {r.hasNextPage ? "+" : ""} {items.length === 1 ? "result" : "results"}{" "}
          for “{q}”
        </p>
      )}
      <div className={LIST}>
        {items.map((a) => (
          <ArtifactRow key={a.id} artifact={a} snippet={a.snippet} />
        ))}
      </div>
      <div ref={sentinel} className="h-px" />
    </section>
  );
}
