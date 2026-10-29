import {
  type AccessLevel,
  type ArtifactSummary,
  MeSchema,
  R,
} from "@oa/shared";
import { useQuery } from "@tanstack/react-query";
import { ApiClientError, api } from "../api/client";
import {
  type ArtifactCan,
  type CapReason,
  canOf,
  type FeatureFlag,
  features,
  type InstanceDirectory,
  type InstanceSignIn,
  type MySpace,
  type SpaceKind,
  type SpaceRole,
  type Tier,
} from "../api/contract";
import { qk } from "../api/queries";

export interface Hosted {
  features: FeatureFlag[];
  tier: Tier | null;
  spaces: MySpace[];
  personalSpaceId: string | null;
  readOnly: boolean;
  cap: CapReason | null;
  signIn: InstanceSignIn | null;
  directory: InstanceDirectory | null;
}

/**
 * The hosted fields of /me; all empty or null on a self-hosted install.
 * A passive observer: it reads whatever useMe fetched and never fetches
 * itself, so mounting it doesn't refetch a failed (anonymous) /me.
 */
export function useHosted(): Hosted {
  const q = useQuery({
    queryKey: qk.me,
    queryFn: ({ signal }) => api.get(R.me, MeSchema, signal),
    enabled: false,
  });
  const anon = q.error instanceof ApiClientError && q.error.status === 401;
  const me = anon ? null : (q.data ?? null);
  return {
    features: features(me),
    tier: me?.instance.tier ?? null,
    spaces: me?.spaces ?? [],
    personalSpaceId: me?.personalSpaceId ?? null,
    readOnly: me?.auth?.readOnly ?? false,
    cap: me?.auth?.cap ?? null,
    signIn: me?.instance.signIn ?? null,
    directory: me?.instance.directory ?? null,
  };
}

/** What the caller may do with `a`. Every action gate reads this, never `access`. */
export const useCan = (a: ArtifactSummary): ArtifactCan => {
  const { features, cap } = useHosted();
  const can = canOf(a, features);
  // A capped caller (guest, restricted, plan) writes nothing, whatever `can`
  // says: the server's answer is the same, this keeps the UI honest if stale.
  return cap == null
    ? can
    : {
        ...can,
        edit: false,
        share: false,
        setVisibility: false,
        delete: false,
        transfer: false,
        move: false,
        dataWrite: false,
      };
};

/** Whether the caller may publish into a space: never when capped (guest, restricted). */
export const canPublishTo = (
  s: { kind: SpaceKind; myRole: SpaceRole | null },
  cap: CapReason | null,
) =>
  cap === null &&
  (s.kind === "personal" || s.myRole === "editor" || s.myRole === "manager");

const LABEL = {
  owner: "Owner",
  manager: "Manager",
  editor: "Editor",
  viewer: "Viewer",
} as const satisfies Record<AccessLevel, string>;

export const accessLabel = (level: AccessLevel) => LABEL[level];

/**
 * The plan locked the instance for this caller (cap "plan", readOnly): every
 * write control is off, reads stay. The org owner is never frozen.
 */
export function useFrozen(): boolean {
  const { cap, readOnly } = useHosted();
  return cap === "plan" && readOnly;
}
