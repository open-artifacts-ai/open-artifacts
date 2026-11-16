// #2632: a seeded Welcome the person never touched is not "something they
// own" where that matters (the remove-member transfer list, the plan's stored
// bytes, the space's page count). Untouched means: it is the Welcome seeded
// for its owner (their per-person settings row names it), still version 1, still
// private, no share, and no comment thread (recorded by markWelcomeTouched).
// No imports: services, billing and the db layer all use it.

/** The per-person row naming a person's seeded Welcome. */
export const WELCOME_PREFIX = "onboarding:welcome:";
/** One row per Welcome that got a comment thread (the thread lives in the page's own store). */
export const TOUCHED_PREFIX = "onboarding:welcome-touched:";

/** SQL for "artifact row `a` is an untouched seeded Welcome" (exact keys, never LIKE). */
export const untouchedWelcomeSql = (a: string): string =>
  `(${a}.current_version = 1 and ${a}.visibility = 'private'
    and exists (select 1 from settings s where s.key = '${WELCOME_PREFIX}' || ${a}.owner_id
      and json_extract(s.value, '$.artifactId') = ${a}.id)
    and not exists (select 1 from shares h where h.artifact_id = ${a}.id)
    and not exists (select 1 from settings t where t.key = '${TOUCHED_PREFIX}' || ${a}.id))`;
