/** The ?mock= switches for For you and asking someone else's agent (#2577), read from the URL. */
import type { ForYouVariant } from "@oa/shared/mocks";

const VARIANTS = ["calm", "empty", "back", "held", "error"] as const;

/** ?mock=foryou[&foryou=calm|empty|back|held|error] (else "mixed"), or ?mock=agent-asks (held). */
export function forYouVariant(p: URLSearchParams): ForYouVariant | undefined {
  const mock = p.get("mock");
  if (mock === "agent-asks") return "held";
  if (mock !== "foryou") return undefined;
  return VARIANTS.find((v) => v === p.get("foryou")) ?? "mixed";
}

/** The held request, the switch and the "listens to" list: with ?mock=agent-asks or &foryou=held. */
export const agentAsksOn = (p: URLSearchParams) =>
  p.get("mock") === "agent-asks" ||
  (p.get("mock") === "foryou" && p.get("foryou") === "held");
