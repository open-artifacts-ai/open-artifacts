import { AUTH } from "@oa/shared";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { ApiClientError, api } from "./client";
import {
  type CodeRequest,
  CodeRequestedSchema,
  CodeVerifiedSchema,
  readAuthProviders,
} from "./contract";

/** `GET AUTH.providers`; an older server's 404 reads as Access mode. */
export const useAuthProviders = (enabled = true) =>
  useQuery({
    queryKey: ["auth-providers"],
    enabled,
    retry: false,
    queryFn: async ({ signal }) => {
      try {
        return readAuthProviders(
          await api.get(AUTH.providers, z.unknown(), signal),
        );
      } catch (e) {
        if (e instanceof ApiClientError && e.status === 404)
          return readAuthProviders(undefined);
        throw e;
      }
    },
  });

/** Emails a sign-in code: 202 with the same body for every well-formed address. */
export const requestCode = (input: CodeRequest) =>
  api.send("POST", AUTH.codeRequest, input, CodeRequestedSchema);

/** Verifies the code for the pending request (cookie); a 401 carries `details.reason`. */
export const verifyCode = (code: string) =>
  api.send("POST", AUTH.codeVerify, { code }, CodeVerifiedSchema);
