import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

/** The signed-in admin's /me (one cached query, shared with the shell). */
export const useMe = () =>
  useQuery({ queryKey: ["me"], queryFn: api.me, retry: false });

/** "prod" or "staging", from the same /me answer the sidebar badge reads. */
export const useEnv = () => useMe().data?.env;
