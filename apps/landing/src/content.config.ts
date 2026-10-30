import { defineCollection } from "astro:content";
import { REPO_URL } from "@oa/shared";
import { glob, type Loader } from "astro/loaders";
import { z } from "astro/zod";
import { LIMIT_PLACEHOLDERS } from "./lib/limits";
import { planWarningsTable } from "./lib/plan-warnings";

// Docs write {REPO_URL} (and {LATEST_RELEASE_API}, derived from it) so the
// repo URL is defined only in @oa/shared, {LIMIT_*} for LIMITS, and
// {PLAN_WARNINGS_TABLE} for scripts/setup's warning strings.
const PLACEHOLDERS: Record<string, string> = {
  ...LIMIT_PLACEHOLDERS,
  "{PLAN_WARNINGS_TABLE}": await planWarningsTable(),
  "{REPO_URL}": REPO_URL,
  "{LATEST_RELEASE_API}": `${REPO_URL.replace("https://github.com/", "https://api.github.com/repos/")}/releases/latest`,
};
const fill = (body: string) =>
  Object.entries(PLACEHOLDERS).reduce((b, [k, v]) => b.replaceAll(k, v), body);
// This wraps the glob loader to fill it in before rendering.
function docsLoader(): Loader {
  const base = glob({ pattern: "*.md", base: "./src/content/docs" });
  return {
    name: "docs",
    async load(ctx) {
      const pending: Promise<unknown>[] = [];
      // Start empty: glob skips unchanged files, but a placeholder's value
      // (a limit, the repo URL) can change while the file doesn't.
      ctx.store.clear();
      const store = new Proxy(ctx.store, {
        get(target, key, receiver) {
          if (key !== "set") return Reflect.get(target, key, receiver);
          return (entry: Parameters<typeof target.set>[0]) => {
            if (!entry.body || fill(entry.body) === entry.body)
              return target.set(entry);
            const body = fill(entry.body);
            pending.push(
              ctx
                .renderMarkdown(body)
                .then((rendered) => target.set({ ...entry, body, rendered })),
            );
            return true;
          };
        },
      });
      await base.load({ ...ctx, store });
      await Promise.all(pending);
    },
  };
}

const docs = defineCollection({
  loader: docsLoader(),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    order: z.number(),
  }),
});

// Privacy Policy and Terms, at /privacy and /terms. Plain markdown, no
// placeholders.
const legal = defineCollection({
  loader: glob({ pattern: "*.md", base: "./src/content/legal" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    updated: z.string(),
  }),
});

export const collections = { docs, legal };
