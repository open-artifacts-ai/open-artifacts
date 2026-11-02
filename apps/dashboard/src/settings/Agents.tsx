import {
  R,
  type TokenCreated,
  TokenCreatedSchema,
  TokenCreateInputSchema,
} from "@oa/shared";
import {
  Button,
  Input,
  Kbd,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  ToggleGroup,
  ToggleGroupItem,
} from "@oa/ui/shadcn";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { ApiClientError, api } from "../api/client";
import {
  qk,
  useOAuthClients,
  useRevokeOAuthClient,
  useRevokeToken,
  useTokens,
} from "../api/queries";
import { useMe } from "../auth/useMe";
import { Modal } from "../layout/Modal";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { relativeTime } from "../library/time";
import { AgentRow } from "./AgentRow";
import { AgentSetupCard } from "./AgentSetupCard";
import { ConfirmDialog } from "./ConfirmDialog";
import { saveTokenCommand, snippets, tokenFile } from "./snippets";
import {
  Code,
  CodeBlock,
  copyText,
  errorText,
  GAP,
  muted,
  SettingsCard,
  STACK,
} from "./ui";

const when = (iso: string) => relativeTime(iso) || "Unknown";

/** Agent picker over one variant's snippets. Both variants show the same
    agents, so the pick survives a variant switch; an agent without a token
    form (Cursor) gets a note instead. */
function SnippetTabs({
  mcpUrl,
  variant,
}: {
  mcpUrl: string;
  variant: "oauth" | "token";
}) {
  const all = snippets(mcpUrl, { tokenFile: tokenFile() });
  const list = all
    .filter((s) => s.variant === "oauth")
    .map(({ agent }) => ({
      agent,
      s: all.find((s) => s.variant === variant && s.agent === agent),
    }));
  const [picked, setPicked] = useState(list[0]?.agent);
  // Values are indexes: Radix builds element ids from them, and agent names
  // have spaces.
  const current = Math.max(
    list.findIndex((s) => s.agent === picked),
    0,
  );
  const listRef = useRef<HTMLDivElement>(null);
  return (
    <Tabs
      value={String(current)}
      onValueChange={(v) => {
        setPicked(list[Number(v)]?.agent);
        // The strip scrolls sideways on phones; keep the picked tab in view
        // (clicks and arrow keys alike).
        listRef.current?.children[Number(v)]?.scrollIntoView?.({
          block: "nearest",
          inline: "nearest",
        });
      }}
      className={`min-w-0 ${GAP}`}
    >
      {/* The strip scrolls, so it clips anything outside it: the hairline is
          an inset shadow, the underline sits at the bottom edge, and the
          focus ring is inset. */}
      <TabsList
        ref={listRef}
        variant="line"
        className="h-[34px] w-full justify-start gap-[var(--oa-space-4)] overflow-x-auto rounded-none p-0 shadow-[inset_0_-1px_0_var(--color-border)] [scrollbar-width:none]"
      >
        {list.map(({ agent }, i) => (
          <TabsTrigger
            key={agent}
            value={String(i)}
            className="h-full flex-none px-0 text-[length:var(--oa-text-sm)] group-data-[orientation=horizontal]/tabs:after:bottom-0 group-data-[orientation=horizontal]/tabs:after:h-[2px] focus-visible:outline-offset-[-2px]"
          >
            {agent}
          </TabsTrigger>
        ))}
      </TabsList>
      {list.map(({ agent, s }, i) => (
        <TabsContent
          key={agent}
          value={String(i)}
          className="grid min-w-0 gap-[var(--oa-space-2)] data-[state=inactive]:hidden"
        >
          {!s ? (
            <p className={muted}>
              {agent} signs in with OAuth, so it doesn't need a token.
            </p>
          ) : (
            <>
              {s.hint && <p className={muted}>{s.hint}</p>}
              {s.file && <p className={muted}>{s.file}</p>}
              {s.language === "text" ? (
                <p className="text-[length:var(--oa-text-sm)]">{s.code}</p>
              ) : (
                <Code
                  code={s.code}
                  label={s.language === "bash" ? "Copy command" : "Copy config"}
                  wrap={variant === "token"}
                />
              )}
            </>
          )}
        </TabsContent>
      ))}
    </Tabs>
  );
}

function Connect({ mcpUrl }: { mcpUrl: string }) {
  const [variant, setVariant] = useState<"oauth" | "token">("oauth");
  return (
    <>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        aria-label="Auth method"
        value={variant}
        // Single toggle groups can deselect; keep one method chosen.
        onValueChange={(v) => v && setVariant(v as "oauth" | "token")}
      >
        <ToggleGroupItem
          value="oauth"
          className="h-[30px] px-[var(--oa-space-3)] text-[length:var(--oa-text-sm)]"
        >
          OAuth
        </ToggleGroupItem>
        <ToggleGroupItem
          value="token"
          className="h-[30px] px-[var(--oa-space-3)] text-[length:var(--oa-text-sm)]"
        >
          Token
        </ToggleGroupItem>
      </ToggleGroup>
      <SnippetTabs mcpUrl={mcpUrl} variant={variant} />
    </>
  );
}

/** Name, meta and actions on one line; at <= 600px the name takes its own
    ellipsized line and the meta and actions share the next. */
const ROWS =
  "grid gap-[var(--oa-space-1)] p-0 max-[600px]:gap-[var(--oa-space-3)]";
const ROW =
  "flex min-h-[34px] items-center gap-[var(--oa-space-3)] max-[600px]:min-h-0 max-[600px]:flex-wrap max-[600px]:gap-y-[var(--oa-space-2)]";
const NAME =
  "min-w-0 flex-1 font-medium [overflow-wrap:anywhere] max-[600px]:basis-full max-[600px]:truncate";
const ACTION = "flex-none text-[length:var(--oa-text-sm)] max-[600px]:ml-auto";

function Confirm({
  title,
  action,
  onClose,
  onConfirm,
}: {
  title: string;
  action: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title={title}
      body={<p>Anything using it stops working immediately.</p>}
      confirm={action}
      danger
      onConfirm={onConfirm}
    />
  );
}

function OAuthClients() {
  const q = useOAuthClients();
  const revoke = useRevokeOAuthClient();
  const state = useMe();
  // Capped (guest, restricted): renaming answers 404, so no label controls.
  const canLabel = state.status === "authed" && state.me.auth?.cap == null;
  const [target, setTarget] = useState<{
    grantId: string;
    clientName: string;
  } | null>(null);
  return (
    <SettingsCard id="oa-oauth-h" title="Connected agents">
      {q.isError ? (
        <p role="alert" className={errorText}>
          Couldn't load connected agents.
        </p>
      ) : q.data?.length === 0 ? (
        <div className="grid gap-[var(--oa-space-1)]">
          <p className="m-0">No agents connected yet.</p>
          <p className={`m-0 ${muted}`}>
            Connect any AI agent with the MCP server above. It shows here once
            you approve it.
          </p>
        </div>
      ) : (
        <ul className="grid p-0">
          {q.data?.map((c) => (
            <AgentRow
              key={c.grantId}
              c={c}
              canLabel={canLabel}
              onRevoke={() => setTarget(c)}
            />
          ))}
        </ul>
      )}
      {target && (
        <Confirm
          title={`Revoke "${target.clientName}"?`}
          action="Revoke"
          onClose={() => setTarget(null)}
          onConfirm={() => revoke.mutate(target.grantId)}
        />
      )}
    </SettingsCard>
  );
}

/** The token lives only in this component's state; closing clears it. */
function CreateDialog({ onClose }: { onClose: () => void }) {
  const state = useMe();
  const mcpUrl = state.status === "authed" ? state.me.instance.mcpUrl : null;
  const qc = useQueryClient();
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<TokenCreated | null>(null);
  const submit = async () => {
    if (busy) return;
    const parsed = TokenCreateInputSchema.safeParse({ label });
    if (!parsed.success) return setError("Enter a label (1–80 characters).");
    setError(null);
    setBusy(true);
    try {
      // Not a react-query mutation: its result would sit in the mutation cache.
      setCreated(
        await api.send("POST", R.tokens, parsed.data, TokenCreatedSchema),
      );
      void qc.invalidateQueries({ queryKey: qk.tokens });
    } catch (e) {
      setError(
        e instanceof ApiClientError ? e.message : "Couldn't create the token.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      // Mid-request or with the token on screen, only Done closes it.
      onClose={() => !busy && !created && onClose()}
      title={created ? "Token created" : "Create token"}
      description={
        created
          ? undefined
          : "Tokens act as you. Give it a label so you can recognize it."
      }
      footer={
        created ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => void submit()}>
              {busy ? "Creating…" : "Create"}
            </Button>
          </>
        )
      }
    >
      {created ? (
        <div className="grid gap-[var(--oa-space-3)]">
          <p role="alert">You won't see this again.</p>
          <CodeBlock copy={created.token} label="Copy token">
            <code className="oa-token block min-w-0 flex-1 p-[var(--oa-space-3)] font-mono text-[length:var(--oa-text-xs)] break-all">
              {created.token}
            </code>
          </CodeBlock>
          {mcpUrl && (
            <>
              <p className={muted}>
                Save this token to a file so your agent can use it without it
                ever appearing in chat. Copy the token above, run this line in a
                terminal, and paste the token when asked. The input stays
                hidden. In Claude Code, type <Kbd>!</Kbd> and a space, then
                paste the line.
              </p>
              <Code code={saveTokenCommand()} label="Copy save command" wrap />
              <p className={muted}>
                Then set up your client below. Never paste the token into chat
                or into a config file.
              </p>
              <SnippetTabs mcpUrl={mcpUrl} variant="token" />
            </>
          )}
        </div>
      ) : (
        <form
          className="grid gap-[var(--oa-space-3)]"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Input
            aria-label="Label"
            autoComplete="off"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          {error && (
            <p role="alert" className={errorText}>
              {error}
            </p>
          )}
        </form>
      )}
    </Modal>
  );
}

function Tokens() {
  const q = useTokens();
  const revoke = useRevokeToken();
  const [creating, setCreating] = useState(false);
  const [target, setTarget] = useState<{ id: string; label: string } | null>(
    null,
  );
  return (
    <SettingsCard
      id="oa-pat-h"
      title="Personal access tokens"
      action={
        <Button
          variant="outline"
          size="sm"
          className="text-[length:var(--oa-text-sm)]"
          onClick={() => setCreating(true)}
        >
          Create token
        </Button>
      }
    >
      {q.isError ? (
        <p role="alert" className={errorText}>
          Couldn't load tokens.
        </p>
      ) : q.data?.length === 0 ? (
        <p className={muted}>
          No tokens. Create one for a script or an agent that can't use OAuth.
        </p>
      ) : (
        <ul className={ROWS}>
          {q.data?.map((t) => (
            <li key={t.id} className={ROW}>
              <b className={NAME}>{t.label}</b>
              <span className={muted}>Created {when(t.createdAt)}</span>
              <span className={muted}>
                Last used {t.lastUsedAt ? when(t.lastUsedAt) : "Never"}
              </span>
              <Button
                className={ACTION}
                variant="ghost"
                size="sm"
                aria-label={`Revoke ${t.label}`}
                disabled={revoke.isPending && revoke.variables === t.id}
                onClick={() => setTarget(t)}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
      {creating && <CreateDialog onClose={() => setCreating(false)} />}
      {target && (
        <Confirm
          title={`Revoke "${target.label}"?`}
          action="Revoke"
          onClose={() => setTarget(null)}
          onConfirm={() => revoke.mutate(target.id)}
        />
      )}
    </SettingsCard>
  );
}

export function Agents() {
  useDocumentTitle("Agents");
  const state = useMe();
  const mcpUrl = state.status === "authed" ? state.me.instance.mcpUrl : null;
  return (
    <div className={STACK}>
      <AgentSetupCard />
      {mcpUrl && (
        <SettingsCard id="oa-mcp-h" title="MCP server">
          <div className="flex min-w-0 items-center gap-[var(--oa-space-2)]">
            <Input
              readOnly
              aria-label="MCP server URL"
              value={mcpUrl}
              className="h-[30px] flex-1 text-[length:var(--oa-text-sm)] md:text-[length:var(--oa-text-sm)]"
            />
            <Button
              variant="outline"
              className="h-[30px] flex-none text-[length:var(--oa-text-sm)]"
              onClick={() => copyText(mcpUrl, "MCP URL copied")}
            >
              Copy URL
            </Button>
          </div>
          <Connect mcpUrl={mcpUrl} />
        </SettingsCard>
      )}
      <OAuthClients />
      <Tokens />
    </div>
  );
}
