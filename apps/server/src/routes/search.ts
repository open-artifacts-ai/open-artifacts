import { R, SearchQuerySchema } from "@oa/shared";
import { caller } from "../auth/authz.js";
import { ApiError } from "../http/errors.js";
import { search } from "../services/search.js";
import type { AppType } from "./index.js";

// Module-scope warm-up: zod builds the parser on first parse (see artifacts.ts).
SearchQuerySchema.safeParse({ q: "a" });

export function mountSearch(app: AppType): void {
  app.get(R.search, async (c) => {
    const q = SearchQuerySchema.safeParse(c.req.query());
    if (!q.success) {
      // Anonymous → 401 before any validation detail.
      if (!c.var.user) throw new ApiError("unauthorized", "Sign in required");
      throw new ApiError("bad_request", "Invalid query", q.error.issues);
    }
    return c.json(
      await search(
        c.env,
        caller(c),
        q.data.q,
        q.data.cursor,
        q.data.limit,
        q.data.spaceId,
        q.data.agentVia,
      ),
    );
  });
}
