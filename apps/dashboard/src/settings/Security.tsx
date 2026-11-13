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
import { Clock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
export const EVERY_PICK_LINE = "Any answer to an ask, not just risky ones.";
export const WAITING = "Waiting for your passkey…";

// Adding a passkey needs a fresh sign-in: the server answers 401
// reauth_required, and the sign-in returns to this page (next=).
export const ADD_AFTER_REAUTH_KEY = "oa.passkey.addAfterReauth";
const ADD_AFTER_REAUTH_MS = 10 * 60 * 1000;
export const ADD_REAUTH_NOTE =
  "Adding a passkey asks you to log in again first.";
export const ADD_RETURN_LINE =
  "You're logged in again. Add your passkey within 10 minutes.";
// Product's words for the step between approving and creating.
export const APPROVED_LINE =
  "Your current passkey was accepted. Now add the new one.";
export const CREATE_BUTTON = "Add passkey";
export const ALREADY_HERE =
  "This device already has a passkey for this account.";
export const REMOVAL_STARTS =
  "This passkey will be removed in 24 hours. You can cancel until then.";
export const REMOVAL_DELAY_LINE =
  "It's removed after 24 hours, so you can cancel if this wasn't you.";
const RemovalSchema = z.object({ removesAt: z.string().nullable() });

type Doing = "added" | "changed" | "removed";

/** Why a passkey step ended, in one line that says nothing happened. */
function failureLine(e: unknown, doing: Doing): string {
  const nothing = `Nothing was ${doing}.`;
  if (e instanceof PasskeyCancelled) return nothing;
  if (e instanceof DOMException && e.name === "InvalidStateError")
    return `${ALREADY_HERE} ${nothing}`;
  if (e instanceof ApiClientError) {
    if (e.code === "passkey_cooling") {
      const until = (e.details as { usableAt?: unknown } | undefined)?.usableAt;
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
      return `That passkey wasn't accepted. ${nothing}`;
    if (e.code === "challenge_expired")
      return `That took too long. Try again. ${nothing}`;
    if (e.code === "rate_limited")
      return `Too many tries. Wait a few minutes. ${nothing}`;
    return `${e.message} ${nothing}`;
  }
  return `Something went wrong. ${nothing}`;
}

/** A 401 reauth_required: follow its same-origin URL. True if we left. */
function followReauth(e: unknown, beforeLeaving?: () => void): boolean {
  if (!(e instanceof ApiClientError) || e.code !== "reauth_required")
    return false;
  const url = sameOriginUrl(
    (e.details as { reauthUrl?: unknown } | undefined)?.reauthUrl,
  );
  if (!url) return false;
  beforeLeaving?.();
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
  // A failure sits under the row that caused it (`id`), or under the list (add).
  const [note, setNote] = useState<{ id: string | null; text: string } | null>(
    null,
  );
  const [removing, setRemoving] = useState<Passkey | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const full = (keys?.length ?? 0) >= MAX_PASSKEYS;
  // No usable passkey to assert with: removal goes by re-auth, 24 h out.
  const reauthPath = !keys?.some((k) => k.usable);
  const addRef = useRef<HTMLButtonElement>(null);
  const [returned, setReturned] = useState(false);
  const [headingTick, setHeadingTick] = useState(0);
  // A second passkey is approved by an existing one first; its creation
  // options wait here for a separate click (one passkey prompt per click).
  const [approved, setApproved] = useState<Record<string, unknown> | null>(
    null,
  );
  const [creating, setCreating] = useState(false);
  const createRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (approved) createRef.current?.focus({ preventScroll: true });
  }, [approved]);

  // Back from the sign-in that Add asked for: say so and focus Add. Never call
  // create() here: Safari wants a user click for it.
  useEffect(() => {
    const mark = sessionStorage.getItem(ADD_AFTER_REAUTH_KEY);
    if (mark === null) return;
    sessionStorage.removeItem(ADD_AFTER_REAUTH_KEY);
    // The mark is the time we left; the sign-in is good for 10 minutes.
    const age = Date.now() - Number(mark);
    if (!(age >= 0 && age <= ADD_AFTER_REAUTH_MS)) return;
    setReturned(true);
    addRef.current?.focus({ preventScroll: true });
  }, []);

  // After a removal the row (and its button) is gone: focus the card heading.
  // A timeout so it lands after the dialog hands focus back.
  useEffect(() => {
    if (headingTick === 0) return;
    const t = setTimeout(
      () =>
        document.getElementById("oa-passkeys")?.focus({ preventScroll: true }),
      0,
    );
    return () => clearTimeout(t);
  }, [headingTick]);

  const [cancelling, setCancelling] = useState<string | null>(null);
  async function cancelRemoval(p: Passkey) {
    if (cancelling) return; // aria-disabled keeps focus on the button
    setCancelling(p.id);
    setNote(null);
    try {
      await api.send("POST", R.passkeyCancelRemoval(p.id), undefined);
      await refresh();
    } catch (e) {
      setNote({ id: p.id, text: failureLine(e, "changed") });
    } finally {
      setCancelling(null);
    }
  }

  async function add() {
    // aria-disabled keeps focus on the button
    if (adding || full || loading || approved) return;
    setAdding(true);
    setNote(null);
    setReturned(false);
    setApproved(null);
    try {
      // With any passkey already there, an existing one approves the new one:
      // challenge (the re-auth check comes first), prompt, then begin with the
      // assertion. The first passkey needs neither.
      let assertion: unknown;
      if ((keys?.length ?? 0) > 0) {
        try {
          const ch = await api.send(
            "POST",
            R.passkeyRegisterChallenge,
            undefined,
            ChallengeSchema,
          );
          assertion = await getAssertion(ch.options);
        } catch (e) {
          // 409 conflict only: none needs to approve after all (our list was
          // stale). passkey_cooling is also a 409 but is an answer, not this.
          if (!(e instanceof ApiClientError && e.code === "conflict")) throw e;
        }
      }
      const begin = await api.send(
        "POST",
        R.passkeyRegisterBegin,
        assertion === undefined ? undefined : { assertion },
        ChallengeSchema,
      );
      if (assertion !== undefined) {
        // Safari allows one passkey prompt per click: stop here, and create
        // on the next click.
        setApproved(begin.options);
        return;
      }
      await createAndFinish(begin.options);
    } catch (e) {
      failAdd(e);
    } finally {
      setAdding(false);
    }
  }

  async function createAndFinish(options: Record<string, unknown>) {
    const credential = await createCredential(options);
    await api.send(
      "POST",
      R.passkeyRegisterFinish,
      { credential },
      PasskeySchema,
    );
    setApproved(null);
    await refresh();
    toast({ title: "Passkey added.", tone: "success" });
  }

  function failAdd(e: unknown) {
    if (
      followReauth(e, () =>
        sessionStorage.setItem(ADD_AFTER_REAUTH_KEY, String(Date.now())),
      )
    )
      return;
    // The options are single use and short lived: after these, start over.
    // A device that already holds one can't create another: start over too.
    if (
      (e instanceof ApiClientError &&
        (e.code === "challenge_expired" || e.code === "passkey_failed")) ||
      (e instanceof DOMException && e.name === "InvalidStateError")
    )
      setApproved(null);
    setNote({ id: null, text: failureLine(e, "added") });
  }

  async function create() {
    if (!approved || creating) return; // aria-disabled keeps focus on the button
    setCreating(true);
    setNote(null);
    try {
      await createAndFinish(approved);
    } catch (e) {
      failAdd(e);
    } finally {
      setCreating(false);
    }
  }

  async function remove(p: Passkey) {
    setRemoveBusy(true);
    setNote(null);
    try {
      // Main path: a passkey assertion, removed at once (204). REAUTH-ONLY
      // BRANCH: with no usable passkey, DELETE with no body; the server wants
      // a fresh sign-in (401 reauth_required, followReauth below), then only
      // schedules the removal 24 h out (202 { removesAt }). Change it here.
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
      const out = await api.send(
        "DELETE",
        R.passkey(p.id),
        assertion === undefined ? undefined : { assertion },
        RemovalSchema,
      );
      await refresh();
      toast({
        title: out?.removesAt ? REMOVAL_STARTS : "Passkey removed.",
        tone: "success",
      });
      if (!out?.removesAt) setHeadingTick((n) => n + 1);
    } catch (e) {
      if (followReauth(e)) return;
      setNote({ id: p.id, text: failureLine(e, "removed") });
    } finally {
      setRemoveBusy(false);
      setRemoving(null);
    }
  }

  return (
    <SettingsCard
      id="oa-passkeys"
      title="Passkeys"
      subtitle="Approve risky actions with your fingerprint, face, device PIN or a security key."
      focusable
      action={
        <Button
          ref={addRef}
          size="sm"
          // Once approved, "Add passkey" below is the one primary action.
          variant={approved ? "outline" : "default"}
          onClick={add}
          aria-disabled={adding || full || loading || !!approved || undefined}
          aria-busy={adding || undefined}
          className="flex-none aria-disabled:opacity-50"
        >
          {adding ? "Adding…" : "Add a passkey"}
        </Button>
      }
    >
      {returned && (
        <p
          role="status"
          className="m-0 text-[length:var(--oa-text-sm)] font-medium text-[var(--oa-success)]"
        >
          {ADD_RETURN_LINE}
        </p>
      )}
      {approved && (
        <div className="flex flex-wrap items-center justify-between gap-[var(--oa-space-3)]">
          <p
            role="status"
            className="m-0 text-[length:var(--oa-text-sm)] font-medium text-[var(--oa-success)]"
          >
            {APPROVED_LINE}
          </p>
          <Button
            ref={createRef}
            size="sm"
            onClick={create}
            aria-disabled={creating || undefined}
            aria-busy={creating || undefined}
            className="aria-disabled:opacity-50"
          >
            {creating ? "Creating…" : CREATE_BUTTON}
          </Button>
        </div>
      )}
      {!returned && !approved && (
        <p className={`m-0 ${muted}`}>{ADD_REAUTH_NOTE}</p>
      )}
      {failed && <p className={errorText}>Couldn't load your passkeys.</p>}
      {keys?.length === 0 && <p className={`m-0 ${muted}`}>No passkeys yet.</p>}
      {keys && keys.length > 0 && (
        <ul className="m-0 grid list-none gap-[var(--oa-space-3)] p-0">
          {keys.map((p) => (
            <li key={p.id} className="grid gap-[var(--oa-space-2)]">
              <div className="flex items-start justify-between gap-[var(--oa-space-3)]">
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
                  {p.removesAt && (
                    <small
                      className={`mt-[2px] flex items-start gap-[6px] text-[length:var(--oa-text-xs)] text-[var(--oa-warning)]`}
                    >
                      <Clock
                        aria-hidden="true"
                        className="mt-[1px] size-3.5 flex-none"
                      />
                      <span>Will be removed {coolingTime(p.removesAt)}</span>
                    </small>
                  )}
                  {!p.usable && (
                    <small
                      className={`mt-[2px] flex items-start gap-[6px] text-[length:var(--oa-text-xs)] text-[var(--oa-warning)]`}
                    >
                      <Clock
                        aria-hidden="true"
                        className="mt-[1px] size-3.5 flex-none"
                      />
                      <span>
                        Can approve from {coolingTime(p.usableAt)}. New passkeys
                        wait 24 hours, in case someone else added one.
                      </span>
                    </small>
                  )}
                </div>
                {p.removesAt ? (
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`Cancel removal of ${p.label}`}
                    aria-disabled={cancelling !== null || undefined}
                    className="aria-disabled:opacity-50"
                    onClick={() => void cancelRemoval(p)}
                  >
                    Cancel removal
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`Remove ${p.label}`}
                    onClick={() => setRemoving(p)}
                  >
                    Remove
                  </Button>
                )}
              </div>
              {note?.id === p.id && (
                <p role="alert" className={`m-0 ${errorText}`}>
                  {note.text}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {full && (
        <p className={`m-0 ${muted}`}>
          You have {MAX_PASSKEYS} passkeys, the most you can add.
        </p>
      )}
      {note?.id === null && (
        <p role="alert" className={`m-0 ${errorText}`}>
          {note.text}
        </p>
      )}
      <ConfirmDialog
        open={removing !== null}
        onClose={() => !removeBusy && setRemoving(null)}
        title={`Remove "${removing?.label ?? ""}"?`}
        body={
          <>
            {reauthPath ? (
              <p>{REMOVAL_DELAY_LINE}</p>
            ) : (
              <p>You won't be able to approve picks with it.</p>
            )}
            {keys?.length === 1 && (
              <p>
                It's your only passkey. Without one, approve risky actions in
                your agent's terminal.
              </p>
            )}
          </>
        }
        confirm="Remove"
        pending="Removing…"
        // Immediate removal is red; a removal that waits 24 hours is not.
        danger={!reauthPath}
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
  // Shown directly under the row (`key`) that caused it.
  const [note, setNote] = useState<{
    key: string;
    text: string;
    error: boolean;
  } | null>(null);
  const none = settings ? !settings.hasPasskey : true;

  async function change(key: AskAction | "everyPick", next: boolean) {
    if (!settings || busy) return;
    setBusy(key);
    setNote(null);
    try {
      // Build the change from the server's state now, so an assertion never
      // binds switches the member did not see.
      const current = await qc.fetchQuery({
        queryKey: qkSettings,
        queryFn: ({ signal }) =>
          api.get(R.passkeySettings, PasskeySettingsSchema, signal),
        staleTime: 0,
      });
      const body = {
        actions: {
          ...current.actions,
          ...(key === "everyPick" ? {} : { [key]: next }),
        },
        everyPick: key === "everyPick" ? next : current.everyPick,
      };
      let saved: PasskeySettings;
      if (next) {
        saved = await api.send(
          "PATCH",
          R.passkeySettings,
          body,
          PasskeySettingsSchema,
        );
      } else {
        setNote({ key, text: WAITING, error: false });
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
      setNote({ key, text: failureLine(e, "changed"), error: true });
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
      subtitle="Approving these needs your passkey. Turning one off needs it too."
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
            : key === "everyPick"
              ? "oa-passkey-every"
              : undefined;
        return (
          <div key={key} className="grid gap-[var(--oa-space-2)]">
            <div className="flex items-center justify-between gap-[var(--oa-space-3)]">
              <div>
                <b className="block text-[length:var(--oa-text-sm)] font-medium">
                  {SWITCH_LABELS[key]}
                </b>
                {locked && (
                  <small id="oa-passkey-locked" className={`block ${muted}`}>
                    {COMMAND_LOCKED_LINE}
                  </small>
                )}
                {key === "everyPick" && (
                  <small id="oa-passkey-every" className={`block ${muted}`}>
                    {EVERY_PICK_LINE}
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
            {note?.key === key && (
              <p
                role={note.error ? "alert" : "status"}
                className={`m-0 ${note.error ? errorText : muted}`}
              >
                {note.text}
              </p>
            )}
          </div>
        );
      })}
    </SettingsCard>
  );
}
