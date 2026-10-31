import type { InstallState } from "@oa/shared/provisioning";
import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { api } from "./client";

export const PAGE_SIZE = 25;

export const worldQuery = () =>
  queryOptions({
    queryKey: ["world"],
    queryFn: () => api.call("R27"),
    refetchInterval: 30_000,
  });
export const installsQuery = (o: {
  cursor?: string;
  state?: InstallState;
  q?: string;
}) =>
  queryOptions({
    queryKey: ["installs", o],
    queryFn: () => api.call("R2", { query: { ...o, limit: PAGE_SIZE } }),
    placeholderData: keepPreviousData,
  });
export const installQuery = (id: string) =>
  queryOptions({
    queryKey: ["install", id],
    queryFn: () => api.call("R3", { params: { id } }),
    retry: false,
  });
export const installJobsQuery = (id: string) =>
  queryOptions({
    queryKey: ["install-jobs", id],
    queryFn: () => api.call("R14", { params: { id }, query: { limit: 5 } }),
  });
export const releasesQuery = () =>
  queryOptions({ queryKey: ["releases"], queryFn: () => api.call("R16") });
export const slugQuery = (slug: string) =>
  queryOptions({
    queryKey: ["slug", slug],
    queryFn: () => api.call("R18", { params: { slug } }),
    staleTime: 10_000,
    retry: false,
  });

/** A job is over when it is done or failed. */
export const jobIsTerminal = (status: string) =>
  status === "done" || status === "failed";
export const JOB_POLL_MS = 2_000;
export const jobQuery = (jobId: string) =>
  queryOptions({
    queryKey: ["job", jobId],
    queryFn: () => api.call("R15", { params: { jobId } }),
    retry: false,
    // Poll while the job runs; stop once it is done or failed.
    // Also stop when the first load failed (404 and the like): nothing to wait for.
    refetchInterval: (q) =>
      q.state.data
        ? jobIsTerminal(q.state.data.status)
          ? false
          : JOB_POLL_MS
        : q.state.status === "error"
          ? false
          : JOB_POLL_MS,
  });
export const auditQuery = (o: {
  cursor?: string;
  installId?: string;
  actor?: string;
  action?: string;
}) =>
  queryOptions({
    queryKey: ["audit", o],
    queryFn: () => api.call("R17", { query: { ...o, limit: PAGE_SIZE } }),
    placeholderData: keepPreviousData,
  });
export const tokensQuery = () =>
  queryOptions({ queryKey: ["tokens"], queryFn: () => api.call("R20") });
