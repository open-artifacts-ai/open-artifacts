// #2590 G2: the guest Google turned away. PROVISIONAL adapter for OA
// Backend's #2604 (swap these for packages/shared's AUTH and schemas when it
// lands): the redirect carries ?error=needs_code&link=1, never the address.
// The address lives in the oa_glink cookie; the page asks for its masked form
// to show, then asks for a code for it, both same-origin so the cookie goes
// along.
import { AUTH, CodeRequestedSchema } from "@oa/shared";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { ApiClientError, api } from "../api/client";

/** PROVISIONAL: AUTH.codeLink, GET -> { maskedEmail } or 404. */
export const CODE_LINK = "/auth/code/link";
const CodeLinkSchema = z.object({ maskedEmail: z.string().min(1) });

/**
 * The masked address the link names: a string, null when there is no link
 * any more (404: start over), undefined while asking.
 */
export function useCodeLink(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: ["auth", "code-link"],
    retry: false,
    queryFn: async ({ signal }) => {
      try {
        return (await api.get(CODE_LINK, CodeLinkSchema, signal)).maskedEmail;
      } catch (e) {
        if (e instanceof ApiClientError && e.status === 404) return null;
        throw e;
      }
    },
  });
}

/** PROVISIONAL: POST codeRequest { link: true } (no address), same-origin. */
export const requestLinkedCode = (input: {
  next: string;
  turnstileToken?: string;
}) =>
  api.send(
    "POST",
    AUTH.codeRequest,
    { link: true, ...input },
    CodeRequestedSchema,
  );
