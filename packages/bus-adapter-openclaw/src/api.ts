// The slice of OpenClaw's plugin API this adapter uses (2026.6.5; types in
// openclaw/dist/plugin-sdk: OpenClawPluginApi, OpenClawPluginToolContext,
// PluginHookAgentContext). Declared here so the package needs no OpenClaw install.
import type { Caller } from "./roots.ts";

export type ToolContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  activeModel?: { provider?: string; modelId?: string; modelRef?: string };
};

export type HookContext = Caller & { runId?: string; sessionId?: string };

export type AgentTool = {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{
    content: { type: "text"; text: string }[];
    details?: unknown;
  }>;
};

export type PluginApi = {
  registrationMode?: string;
  registerTool(
    tool: (ctx: ToolContext) => AgentTool[] | AgentTool | null | undefined,
    opts?: { names?: string[] },
  ): void;
  on(
    hook: "before_prompt_build",
    handler: (ev: { prompt?: string }, ctx: HookContext) => unknown,
  ): void;
  on(
    hook: "model_call_started",
    handler: (
      ev: { runId?: string; sessionKey?: string },
      ctx: HookContext,
    ) => unknown,
  ): void;
  on(
    hook: "model_call_ended",
    handler: (
      ev: { runId?: string; sessionKey?: string; outcome?: string },
      ctx: HookContext,
    ) => unknown,
  ): void;
};
