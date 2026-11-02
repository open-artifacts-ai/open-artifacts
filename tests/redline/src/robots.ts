// What each host's /robots.txt says, for the live case. The server's
// test/skeleton.test.ts pins the Worker's output to the same text, and
// test/robots.test.ts fails if the two ever differ.

/** The content host: nothing there is for crawlers. */
export const CONTENT_ROBOTS = "User-agent: *\nDisallow: /";

/** The app host opens only the guides any AI agent is sent to read. */
export const APP_ROBOTS =
  "User-agent: *\nAllow: /llms.txt\nAllow: /skill.md\nAllow: /upgrade.md\nDisallow: /";

/** The release that first serves /llms.txt and APP_ROBOTS (#870). */
export const AGENT_GUIDES_SINCE = "0.96.0";
