// #3132: the handover card. An agent asked to take over (or set, or remove) a
// role; the member answers with one click, in their own browser session
// (POST R.busRoleProposal). The same card shows in For you > Needs you and on
// the role's row in Agents > Roles. Plain words; the sentence is shared with
// the server's item text (roleCardText).
import { type RoleCard as RoleCardData, roleCardText } from "@oa/shared";
import { Button } from "@oa/ui/shadcn";
import { ApiClientError } from "../api/client";
import { useDecideRoleProposal } from "../foryou/api";

/** Why a Yes was refused (409 details.reason), in plain words; nothing was moved. */
const REFUSED: Record<string, string> = {
  used: "This was already answered.",
  expired: "This ask has expired. Ask the agent to send it again.",
  changed: "The role changed since this was asked, so nothing was moved.",
  agent_not_open: "That agent isn't open anymore, so nothing was moved.",
  name_taken: "That name is taken in this namespace, so nothing was moved.",
  role_limit: "You have the most roles allowed, so nothing was moved.",
};

export function roleDecideError(e: unknown): string {
  if (e instanceof ApiClientError) {
    const reason = (e.details as { reason?: unknown } | undefined)?.reason;
    if (typeof reason === "string" && REFUSED[reason]) return REFUSED[reason];
    if (e.status === 404) return "This ask is gone.";
  }
  return "That didn't go through. Try again.";
}

export function RoleCard({
  card,
  now,
}: {
  card: RoleCardData;
  /** For the "away N min" wording (tests pin it). */
  now?: number;
}) {
  const decide = useDecideRoleProposal();
  const yes =
    card.action === "clear"
      ? "Yes, remove it"
      : card.action === "set"
        ? "Yes, give it"
        : "Yes, hand it over";
  const answer = (decision: "confirm" | "reject") =>
    decide.mutate({ id: card.proposalId, decision });
  return (
    <div data-role-card={card.proposalId} className="grid gap-1.5">
      <span>{roleCardText(card, now)}</span>
      <span className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          disabled={decide.isPending}
          onClick={() => answer("confirm")}
        >
          {yes}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={decide.isPending}
          onClick={() => answer("reject")}
        >
          No
        </Button>
      </span>
      {decide.isError && (
        <p
          role="alert"
          className="m-0 text-[length:var(--oa-text-sm)] text-destructive"
        >
          {roleDecideError(decide.error)}
        </p>
      )}
    </div>
  );
}
