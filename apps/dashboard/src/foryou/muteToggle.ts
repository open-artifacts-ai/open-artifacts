/**
 * Mute or unmute a page or an agent from where the noise is (#2860). A mute
 * stops push only: the item still shows in For you. Offered only on a server
 * with For you (Me.inbox), to a signed-in person.
 */

import type { Me } from "@oa/shared";
import { useQueryClient } from "@tanstack/react-query";
import { qk } from "../api/queries";
import { toast } from "../layout/toast";
import { useMute, useMutes, useUnmute } from "./api";
import { muteErrorCopy } from "./prefsContract";

export type MuteTarget = { kind: "agent" | "page"; id: string };

export function useMuteToggle(target: MuteTarget | null, name: string) {
  // Read from the cache, never observed: a title bar for a signed-out viewer must not refetch /me.
  const qc = useQueryClient();
  const me = qc.getQueryData<Me>(qk.me);
  const available = !!target && me?.inbox !== undefined;
  const mutes = useMutes(available);
  const mute = useMute();
  const unmute = useUnmute();
  const muted =
    !!target &&
    !!mutes.data?.items.some(
      (m) => m.kind === target.kind && m.id === target.id,
    );
  const toggle = () => {
    if (!target) return;
    if (muted) {
      unmute.mutate(target, {
        onSuccess: () => toast({ title: `Unmuted ${name}.`, tone: "neutral" }),
        onError: (e) =>
          toast({ title: muteErrorCopy(e, "unmute"), tone: "danger" }),
      });
      return;
    }
    mute.mutate(target, {
      onError: (e) =>
        toast({ title: muteErrorCopy(e, "mute"), tone: "danger" }),
      onSuccess: () =>
        toast({
          title:
            target.kind === "page"
              ? `Muted "${name}". Its asks still show in For you.`
              : `Muted ${name}. Its asks to you still show in For you.`,
          tone: "neutral",
          action: {
            label: "Undo",
            onClick: () =>
              unmute.mutate(target, {
                onError: (e) =>
                  toast({ title: muteErrorCopy(e, "unmute"), tone: "danger" }),
              }),
          },
        }),
    });
  };
  return { available, muted, loaded: mutes.isSuccess, toggle };
}
