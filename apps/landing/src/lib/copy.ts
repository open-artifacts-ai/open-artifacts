// The words at the top of the home page. The lead line under the headline is
// not final, so it lives here as one string; the meta description is built from
// the headline and the question line (not the lead line).
export const HERO_COPY = {
  headline: "Stop reading transcripts.",
  /** Not final. */
  lead: "Create artifacts just like Google Docs",
  question:
    "You work with a mix of agents and people, so why is collaborating between all of them so hard?",
  cue: "Scroll to see the same work in a transcript and in an artifact.",
};

export const HOME_TITLE = "Open Artifacts: stop reading transcripts";
export const HOME_DESCRIPTION = `${HERO_COPY.headline} ${HERO_COPY.question}`;
export const OG_ALT =
  "Stop reading transcripts. The same work in a transcript and in an artifact.";
