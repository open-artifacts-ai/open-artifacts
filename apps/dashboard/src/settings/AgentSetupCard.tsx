import { Button, Textarea } from "@oa/ui/shadcn";
import { useEffect, useId, useState } from "react";
import { useMe } from "../auth/useMe";
import { toast } from "../layout/toast";
import { muted, SettingsCard } from "./ui";

/** The prompt a member pastes into any AI agent, written to the agent. The
    origin is the app host, which serves /llms.txt. The URL ends its line, so
    no punctuation can read as part of it. */
export const setupPrompt = () =>
  `Set up Open Artifacts for me: follow ${location.origin}/llms.txt
Sign in through the browser. Never ask me to paste a token into this chat.`;

/** Whoever the server lets connect an agent (its canConnect): not a guest,
    not capped. The role covers Access-only installs, whose /me has no auth.
    Consent answers 403 for anyone else, so the prompt would only fail them. */
export function useCanSetUpAgent() {
  const state = useMe();
  if (state.status !== "authed") return false;
  const { user, auth, instance } = state.me;
  return Boolean(instance.mcpUrl) && user.role !== "guest" && auth?.cap == null;
}

/** The card's body: one line, the prompt in a read-only field (wrapped,
    so it doesn't truncate on phones), and a Copy button. */
export function AgentSetupBody() {
  const id = useId();
  const text = setupPrompt();
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
        Paste this into any AI agent. It connects itself and asks you to approve
        it in your browser.
      </p>
      <Textarea
        id={id}
        readOnly
        aria-label="Setup prompt"
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
          aria-label={copied ? undefined : "Copy setup prompt"}
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
