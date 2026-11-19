/** #2577: asking someone else's agent. The caller's side: held requests, the switch, "listens to". */
import {
  AgentRequestsSwitchSchema,
  type AllowBody,
  type AllowResult,
  AllowResultSchema,
  AskHistorySchema,
  type HeldList,
  HeldListSchema,
  type ListenAddBody,
  ListenAddResultSchema,
  type ListensList,
  ListensListSchema,
  R,
} from "@oa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import { qk } from "./queries";

export const heldKey = ["agent-asks", "held"] as const;
export const listensKey = ["agent-asks", "listens"] as const;
export const requestsKey = ["agent-requests"] as const;

/** The requests waiting for the caller, with the words as they stand now. Browser session only. */
export const useHeld = (enabled = true) =>
  useQuery({
    queryKey: heldKey,
    queryFn: ({ signal }): Promise<HeldList> =>
      api.get(R.agentAskHeld, HeldListSchema, signal),
    enabled,
    staleTime: 0,
  });

/** What an allow or "Not now" changes: the notice, the list in Settings, the bell. */
const useRefresh = () => {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: heldKey });
    void qc.invalidateQueries({ queryKey: listensKey });
    void qc.invalidateQueries({ queryKey: ["inbox"] });
    void qc.invalidateQueries({ queryKey: qk.me, exact: true });
  };
};

export type AllowInput = Pick<AllowBody, "level" | "items" | "until">;

/**
 * Allows the held requests as listed. "space" and "all" carry an end date.
 */
export const useAllowHeld = (id: string) => {
  const refresh = useRefresh();
  return useMutation({
    // #2864: no passkey step for now; "space" and "all" send an end date only.
    mutationFn: (v: AllowInput): Promise<AllowResult> =>
      api.send("POST", R.agentAskHeldAllow(id), v, AllowResultSchema),
    onSettled: refresh,
  });
};

export const useNotNow = (id: string) => {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: () => api.send("POST", R.agentAskHeldNotNow(id), undefined),
    onSettled: refresh,
  });
};

/** The "Teammates can ask my agents" switch. Default on. */
export const useAgentRequests = () =>
  useQuery({
    queryKey: requestsKey,
    queryFn: ({ signal }) =>
      api.get(R.agentRequests, AgentRequestsSwitchSchema, signal),
  });

export const useSetAgentRequests = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (on: boolean) =>
      api.send("PUT", R.agentRequests, { on }, AgentRequestsSwitchSchema),
    onSuccess: (d) => qc.setQueryData(requestsKey, d),
  });
};

/** The caller's live "listens to" entries. Browser session only. */
export const useListens = (enabled = true) =>
  useQuery({
    enabled,
    queryKey: listensKey,
    queryFn: ({ signal }): Promise<ListensList> =>
      api.get(R.agentListens, ListensListSchema, signal),
  });

export const useRemoveListen = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.send("DELETE", R.agentListen(id), undefined),
    onSettled: () => qc.invalidateQueries({ queryKey: listensKey }),
  });
};

export const historyKey = ["agent-asks", "history"] as const;

/** "Who asked what": the last 30 days, newest first. No words. Browser session only. */
export const useAskHistory = (enabled = true) =>
  useQuery({
    enabled,
    queryKey: historyKey,
    queryFn: ({ signal }) =>
      api.get(R.agentAskHistory, AskHistorySchema, signal),
  });

/** Adds teammates to the list directly (Settings, the share tick, first setup). A refusal is a plain 400 message. */
export const useAddListens = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ListenAddBody) =>
      api.send("POST", R.agentListens, body, ListenAddResultSchema),
    onSuccess: () => qc.invalidateQueries({ queryKey: listensKey }),
  });
};
