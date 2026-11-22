import { readStagingPat, STAGING_ORIGIN, test } from "./fixtures";
import { checkMemberComments } from "./member-comments";

test.skip(
  !process.env.OA_STAGING_SHARE_PAT_FILE,
  "Second staging member PAT file is unset",
);

test("two members comment on a private page and PATs cannot read browser-only agent requests", async ({
  stagingArtifact: { agent, id },
}) => {
  await checkMemberComments(
    STAGING_ORIGIN,
    id,
    agent,
    await readStagingPat("OA_STAGING_PAT_FILE"),
    await readStagingPat("OA_STAGING_SHARE_PAT_FILE"),
  );
});
