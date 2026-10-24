// The hero's buttons (#421). Hosted sign-up leads once HOSTED_SIGNUP_URL is
// set at build time; until then self-hosting is the only, primary, action.
export type HeroAction = { label: string; href: string; primary: boolean };

export const SELF_HOST_HREF = "#self-host";

export function heroActions(signupUrl: string | undefined): HeroAction[] {
  const url = signupUrl?.trim();
  if (!url)
    return [{ label: "Self-host it", href: SELF_HOST_HREF, primary: true }];
  return [
    { label: "Get started free", href: url, primary: true },
    { label: "Self-host it", href: SELF_HOST_HREF, primary: false },
  ];
}
