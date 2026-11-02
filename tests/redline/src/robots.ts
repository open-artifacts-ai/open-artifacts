// What each host's /robots.txt says. The server's test/skeleton.test.ts checks
// these against what the Worker emits, so the live case compares a staging
// install to the code's real output, not to a hand copy.

/** The content host: nothing there is for crawlers. */
export const CONTENT_ROBOTS = "User-agent: *\nDisallow: /";

/** The app host opens only the guides any AI agent is sent to read. */
export const APP_ROBOTS =
  "User-agent: *\nAllow: /llms.txt\nAllow: /skill.md\nAllow: /upgrade.md\nDisallow: /";

/** The release that first serves /llms.txt and APP_ROBOTS (#870). */
export const AGENT_GUIDES_SINCE = "0.96.0";
