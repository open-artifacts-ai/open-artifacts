// The installer's harness table, from the zod-free shared leaf. #1551 reads it;
// until then this module keeps the bundle exercising the subpath.
import { harnessSkills } from "@oa/shared/harness-skills";

export const harnessNames: string[] = Object.keys(harnessSkills);
