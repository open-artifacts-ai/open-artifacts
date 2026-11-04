import { z } from "zod";

export const AGENT_KINDS = [
  "claude-code",
  "opencode",
  "pi",
  "omp",
  "codex",
] as const;
export const AgentKindSchema = z.enum(AGENT_KINDS);
export type AgentKind = z.infer<typeof AgentKindSchema>;

/**
 * The shape of any agent kind, known or not yet. What a reader accepts where
 * the instance or the local client reports a kind (roster rows), so a new kind
 * never fails a whole roster. Readers show an unknown kind by its own token,
 * never as another kind. Writers (`agent_up`, the local `hello`) stay on
 * AgentKindSchema.
 */
export const KindTokenSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
