import {
  ASK_ACTIONS,
  type AskAction,
  type Passkey,
  PasskeySchema,
  type PasskeySettings,
  PasskeySettingsSchema,
  R,
} from "@oa/shared";
import { Button } from "@oa/ui/shadcn";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import { ApiClientError, api } from "../api/client";
import { useMe } from "../auth/useMe";
import {
  coolingTime,
  createCredential,
  getAssertion,
  PasskeyCancelled,
  redirectTo,
  sameOriginUrl,
} from "../auth/webauthn";
import { toast } from "../layout/toast";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { ConfirmDialog } from "./ConfirmDialog";
import { Switch } from "./spaces/Switch";
import { errorText, muted, SettingsCard } from "./ui";

const MAX_PASSKEYS = 10;
const ChallengeSchema = z.object({
  options: z.record(z.string(), z.unknown()),
  expiresAt: z.string(),
});

const qkPasskeys = ["passkeys"] as const;
const qkSettings = ["passkeys", "settings"] as const;

export const SWITCH_LABELS: Record<AskAction | "everyPick", string> = {
  merge: "Merge",
  deploy: "Deploy",
  delete: "Delete",
  share: "Share",
  public: "Make public",
  command: "Run a command",
  everyPick: "Every pick",
};
export const NO_PASSKEY_LINE = "Add a passkey to use these.";
export const COMMAND_LOCKED_LINE =
  "Always on: this runs code on your computer.";
export const WAITING = "Waiting for your passkey…";

type Doing = "added" | "changed" | "removed";

/** Why a passkey step ended, in one line that says nothing happened. */
function failureLine(e: unknown, doing: Doing): string {
  const nothing = `Nothing was ${doing}.`;
  if (e instanceof PasskeyCancelled) return nothing;
  if (e instanceof ApiClientError) {
    if (e.code === "passkey_cooling") {
      const until = (e.details as { until?: unknown } | undefined)?.until;
      const when =
        typeof until === "string" && !Number.isNaN(Date.parse(until))
          ? ` from ${coolingTime(until)}`
          : " soon";
      return `Your new passkey can approve${when}. ${nothing}`;
    }
    if (e.code === "no_passkey") return `${NO_PASSKEY_LINE} ${nothing}`;
    if (e.code === "passkey_required")
      return `Your passkey is needed for this. ${nothing}`;
    if (e.code === "passkey_failed")
      return `That passkey didn't check out. ${nothing}`;
    if (e.code === "challenge_expired") return `That took too long. ${nothing}`;
    if (e.code === "rate_limited")
      return `Too many tries. Wait a few minutes. ${nothing}`;
    return `${e.message} ${nothing}`;
  }
  return `Something went wrong. ${nothing}`;
}

/** A 401 reauth_required: follow its same-origin URL. True if we left. */
function followReauth(e: unknown): boolean {
  if (!(e instanceof ApiClientError) || e.code !== "reauth_required")
    return false;
  const url = sameOriginUrl(
    (e.details as { reauthUrl?: unknown } | undefined)?.reauthUrl,
  );
  if (!url) return false;
  redirectTo(url);
  return true;
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

/** Settings › Security: passkeys, and which picks ask for one (#2263). */
export function Security() {
  useDocumentTitle("Security");
  const state = useMe();
  if (state.status !== "authed") return null;
  return <SecurityBody />;
}

function SecurityBody() {
  const qc = useQueryClient();
  const keys = useQuery({
    queryKey: qkPasskeys,
    queryFn: ({ signal }) =>
      api.get(R.passkeys, z.array(PasskeySchema), signal),
  });
  const settings = useQuery({
    queryKey: qkSettings,
    queryFn: ({ signal }) =>
      api.get(R.passkeySettings, PasskeySettingsSchema, signal),
  });
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: qkPasskeys }),
      qc.invalidateQueries({ queryKey: qkSettings }),
    ]);
  return (
    <div className="grid max-w-[560px] gap-[var(--oa-space-4)]">
      <PasskeyList
        keys={keys.data}
        loading={keys.isPending}
        failed={keys.isError}
        refresh={refresh}
      />
      <Switches settings={settings.data} failed={settings.isError} />
    </div>
  );
}

function PasskeyList({
  keys,
  loading,
  failed,
  refresh,
}: {
  keys: Passkey[] | undefined;
  loading: boolean;
  failed: boolean;
  refresh: () => Promise<unknown>;
}) {
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Passkey | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const full = (keys?.length ?? 0) >= MAX_PASSKEYS;

  async function add() {
    if (adding) return;
    setAdding(true);
    setNote(null);
    try {
      const begin = await api.send(
        "POST",
        R.passkeyRegisterBegin,
        undefined,
        ChallengeSchema,
      );
      const credential = await createCredential(begin.options);
      await api.send(
        "POST",
        R.passkeyRegisterFinish,
        { credential },
        PasskeySchema,
      );
      await refresh();
      toast({ title: "Passkey added.", tone: "success" });
    } catch (e) {
      if (followReauth(e)) return;
      setNote(failureLine(e, "added"));
    } finally {
      setAdding(false);
    }
  }

  async function remove(p: Passkey) {
    setRemoveBusy(true);
    setNote(null);
    try {
      // Main path: a passkey assertion. REAUTH-ONLY BRANCH (no usable
      // passkey: DELETE with no body, the server asks for a fresh sign-in via
      // 401 reauth_required) is the `else` below plus followReauth; the server
      // is moving it to a 24 h pending removal, so change it here only.
      let assertion: unknown;
      if (keys?.some((k) => k.usable)) {
        const ch = await api.send(
          "POST",
          R.passkeyChallenge(p.id),
          undefined,
          ChallengeSchema,
        );
        assertion = await getAssertion(ch.options);
      }
      await api.send(
        "DELETE",
        R.passkey(p.id),
        assertion === undefined ? undefined : { assertion },
      );
      await refresh();
      toast({ title: "Passkey removed.", tone: "success" });
    } catch (e) {
      if (followReauth(e)) return;
      setNote(failureLine(e, "removed"));
    } finally {
      setRemoveBusy(false);
      setRemoving(null);
    }
  }

  return (
    <SettingsCard
      id="oa-passkeys"
      title="Passkeys"
      subtitle="Approve risky picks with your fingerprint, face or device PIN."
      action={
        <Button
          size="sm"
          onClick={add}
          disabled={adding || full || loading}
          aria-busy={adding || undefined}
        >
          {adding ? "Adding…" : "Add a passkey"}
        </Button>
      }
    >
      {failed && <p className={errorText}>Couldn't load your passkeys.</p>}
      {keys?.length === 0 && <p className={`m-0 ${muted}`}>No passkeys yet.</p>}
      {keys && keys.length > 0 && (
        <ul className="m-0 grid list-none gap-[var(--oa-space-3)] p-0">
          {keys.map((p) => (
            <li
              key={p.id}
              className="flex items-start justify-between gap-[var(--oa-space-3)]"
            >
              <div className="min-w-0">
                <b className="block text-[length:var(--oa-text-sm)] font-medium [overflow-wrap:anywhere]">
                  {p.label}
                </b>
                <small className={`block ${muted}`}>
                  Added {day(p.createdAt)}
                  {" · "}
                  {p.lastUsedAt
                    ? `Last used ${day(p.lastUsedAt)}`
                    : "Never used"}
                </small>
                {!p.usable && (
                  <small className={`block ${muted}`}>
                    Can approve from {coolingTime(p.usableAt)}
                  </small>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                aria-label={`Remove ${p.label}`}
                onClick={() => setRemoving(p)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {full && (
        <p className={`m-0 ${muted}`}>
          You have {MAX_PASSKEYS} passkeys, the most you can add.
        </p>
      )}
      <p role="status" className={note ? errorText : "sr-only"}>
        {note}
      </p>
      <ConfirmDialog
        open={removing !== null}
        onClose={() => !removeBusy && setRemoving(null)}
        title={`Remove "${removing?.label ?? ""}"?`}
        body={<p>You won't be able to approve picks with it.</p>}
        confirm="Remove"
        pending="Removing…"
        danger
        busy={removeBusy}
        onConfirm={() => removing && void remove(removing)}
      />
    </SettingsCard>
  );
}

function Switches({
  settings,
  failed,
}: {
  settings: PasskeySettings | undefined;
  failed: boolean;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(
    null,
  );
  const none = settings ? !settings.hasPasskey : true;

  async function change(key: AskAction | "everyPick", next: boolean) {
    if (!settings || busy) return;
    const body = {
      actions: {
        ...settings.actions,
        ...(key === "everyPick" ? {} : { [key]: next }),
      },
      everyPick: key === "everyPick" ? next : settings.everyPick,
    };
    setBusy(key);
    setNote(null);
    try {
      let saved: PasskeySettings;
      if (next) {
        saved = await api.send(
          "PATCH",
          R.passkeySettings,
          body,
          PasskeySettingsSchema,
        );
      } else {
        setNote({ text: WAITING, error: false });
        const ch = await api.send(
          "POST",
          R.passkeySettingsChallenge,
          body,
          ChallengeSchema,
        );
        const assertion = await getAssertion(ch.options);
        saved = await api.send(
          "PATCH",
          R.passkeySettings,
          { ...body, assertion },
          PasskeySettingsSchema,
        );
      }
      qc.setQueryData(qkSettings, saved);
      setNote(null);
    } catch (e) {
      setNote({ text: failureLine(e, "changed"), error: true });
      void qc.invalidateQueries({ queryKey: qkSettings });
    } finally {
      setBusy(null);
      document
        .getElementById(`oa-passkey-switch-${key}`)
        ?.focus({ preventScroll: true });
    }
  }

  const rows = [...ASK_ACTIONS, "everyPick" as const];
  return (
    <SettingsCard
      id="oa-passkey-asks"
      title="Ask for a passkey to approve"
      subtitle="Picks that do these things need your passkey."
    >
      {failed && <p className={errorText}>Couldn't load these settings.</p>}
      {none && settings && (
        <p id="oa-passkey-none" className={`m-0 ${muted}`}>
          {NO_PASSKEY_LINE}
        </p>
      )}
      {rows.map((key) => {
        const locked = key === "command";
        const on =
          settings === undefined
            ? false
            : key === "everyPick"
              ? settings.everyPick
              : settings.actions[key];
        const hint = locked
          ? "oa-passkey-locked"
          : none
            ? "oa-passkey-none"
            : undefined;
        return (
          <div
            key={key}
            className="flex items-center justify-between gap-[var(--oa-space-3)]"
          >
            <div>
              <b className="block text-[length:var(--oa-text-sm)] font-medium">
                {SWITCH_LABELS[key]}
              </b>
              {locked && (
                <small id="oa-passkey-locked" className={`block ${muted}`}>
                  {COMMAND_LOCKED_LINE}
                </small>
              )}
            </div>
            <Switch
              id={`oa-passkey-switch-${key}`}
              label={SWITCH_LABELS[key]}
              describedBy={hint}
              checked={locked ? true : on}
              disabled={!settings || none || locked}
              onChange={(next) => void change(key, next)}
            />
          </div>
        );
      })}
      <p role="status" className={note?.error ? errorText : muted}>
        {note?.text}
      </p>
    </SettingsCard>
  );
}
