import { Button, Textarea } from "@oa/ui/shadcn";
import { useEffect, useId, useState } from "react";
import { useMe } from "../auth/useMe";
import { toast } from "../layout/toast";
import { muted, SettingsCard } from "./ui";

/** The instruction a member pastes into any AI agent. The origin is the app
    host, which serves /llms.txt. */
export const setupInstruction = () =>
  `Add this Open Artifacts instance: follow ${location.origin}/llms.txt. Never paste a token in chat.`;

/** Same rule as the MCP server card on Settings > Agents: whoever has an
    MCP URL to connect with. */
export function useCanSetUpAgent() {
  const state = useMe();
  return state.status === "authed" && Boolean(state.me.instance.mcpUrl);
}

/** The card's body: one line, the instruction in a read-only field (wrapped,
    so it doesn't truncate on phones), and a Copy button. */
export function AgentSetupBody() {
  const id = useId();
  const text = setupInstruction();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = () => {
    const failed = () =>
      toast({
        title: "Couldn't copy",
        description: "Select it and copy it yourself.",
        tone: "danger",
      });
    if (!navigator.clipboard) return failed();
    navigator.clipboard.writeText(text).then(() => setCopied(true), failed);
  };
  return (
    <div className="grid min-w-0 gap-[var(--oa-space-2)] text-left">
      <p className={`m-0 ${muted}`}>
        Paste this into any AI agent to connect it to this instance.
      </p>
      <Textarea
        id={id}
        readOnly
        aria-label="Setup instruction"
        rows={3}
        value={text}
        onFocus={(e) => e.currentTarget.select()}
        className="min-h-0 resize-none font-mono text-[length:var(--oa-text-xs)] md:text-[length:var(--oa-text-xs)]"
      />
      <div>
        <Button
          variant="outline"
          size="sm"
          className="h-[30px] text-[length:var(--oa-text-sm)]"
          onClick={copy}
        >
          {copied ? "✓ Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

/** Settings > Agents: the card. Nothing for those who can't connect agents. */
export function AgentSetupCard() {
  if (!useCanSetUpAgent()) return null;
  return (
    <SettingsCard id="oa-setup-h" title="Set up with an agent">
      <AgentSetupBody />
    </SettingsCard>
  );
}
