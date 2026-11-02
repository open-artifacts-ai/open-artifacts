// How to name a person, in one place: a released address (a deleted Workspace
// account's row, isReleasedAddress) is never shown.
import { isReleasedAddress } from "@oa/shared";
import { displayName } from "@oa/ui";

type Person = { name?: string | null; email?: string | null };

const FORMER_MEMBER = "Former member";
const IN_A_SENTENCE = "a former member";

/** Their address was released: no address to show, and no way to restore. */
export const isReleased = (u: Person) => isReleasedAddress(u.email);

/** The server's name falls back to the email, so that can be the address too. */
const realName = (u: Person) => {
  const name = u.name?.trim();
  return name && !isReleasedAddress(name) ? name : null;
};

/** The label for a person: displayName, with "Former member" for no name left. */
export const personName = (u: Person) =>
  isReleased(u) ? (realName(u) ?? FORMER_MEMBER) : displayName(u);

/** personName inside a sentence: "a former member". */
export const personInSentence = (u: Person) =>
  isReleased(u) && !realName(u) ? IN_A_SENTENCE : personName(u);

/** "Bob" from "Bob Builder", else the email's local part, else in a sentence. */
export const personFirst = (u: Person) =>
  isReleased(u) && !realName(u)
    ? IN_A_SENTENCE
    : realName(u)?.split(/\s+/)[0] || (u.email ?? "").split("@")[0];
