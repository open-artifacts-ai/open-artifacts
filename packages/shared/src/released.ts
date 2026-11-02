/**
 * Whether `email` is the stand-in a deleted Workspace account's row holds once
 * directory sync released its address (`removed+<id>@invalid`). Never show it.
 */
export const isReleasedAddress = (email: string | null | undefined) =>
  !!email && /^removed\+[^@\s]+@invalid$/.test(email);
