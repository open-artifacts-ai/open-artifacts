import { QUOTA_MESSAGE } from "@oa/shared";
import { useQuery } from "@tanstack/react-query";
import { QUOTA_KEY } from "../api/queryClient";
import { Notice } from "./Notice";

/** Shown once any query or mutation has failed with `quota_exceeded`. */
export function QuotaBanner() {
  const { data } = useQuery({
    queryKey: QUOTA_KEY,
    queryFn: () => false,
    enabled: false,
    initialData: false,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
  return data ? <Notice tone="warning" title={QUOTA_MESSAGE} /> : null;
}
