// The Welcome artifact a new hosted instance is seeded with (#2287). The page
// is in @oa/shared (welcome-page.ts), where the dashboard's tests load it too;
// `origin` is this instance's app origin.
import { WELCOME_TITLE, welcomePage } from "@oa/shared";

export { WELCOME_TITLE };
export const welcomeHtml = (origin: string): string => welcomePage(origin);
