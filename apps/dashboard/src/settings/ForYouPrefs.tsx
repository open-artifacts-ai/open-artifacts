/**
 * Settings › Notifications for For you (#2512 slice 2), Design's screen 4:
 * where each level reaches you, quiet hours, what may interrupt, lock
 * screens, and the muted list. Prefs are R.meNotificationPrefs (PUT whole);
 * mutes are R.meInboxMutes. The browser switch is slice 3: a stub for now.
 */
import type { InboxMutes } from "@oa/shared";
import { Button } from "@oa/ui/shadcn";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  browserTimeZone,
  useMutes,
  usePrefs,
  useSavePrefs,
  useUnmute,
} from "../foryou/api";
import {
  muteErrorCopy,
  type NotificationPrefs,
  type PushSubscriptionItem,
} from "../foryou/prefsContract";
import {
  PermissionRefused,
  PUSH_WORDS,
  permission,
  pushSubsKey,
  pushSupported,
  thisBrowser,
  thisSubscription,
  turnOn,
  usePatchSubscription,
  usePushKey,
  usePushSubscriptions,
} from "../foryou/push";
import { toast } from "../layout/toast";
import { OptionSelect } from "./OptionSelect";
import { Switch } from "./spaces/Switch";
import { muted } from "./ui";

/** Quiet hours when turned on: Design's 22:00 to 07:30. */
export const QUIET_DEFAULT = { start: "22:00", end: "07:30" };

/** Every half hour, "00:00" to "23:30". */
export const HALF_HOURS = Array.from({ length: 48 }, (_, i) => {
  const t = `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`;
  return { value: t, label: t };
});

export { thisBrowser } from "../foryou/push";

const MUTED_SM = "text-[12.5px] text-[var(--oa-text-muted)]";
const BOX =
  "rounded-[12px] border border-[var(--oa-divider)] bg-[var(--oa-surface)] px-3.5 py-3 text-[length:var(--oa-text-sm)]";
const ROW =
  "flex items-center justify-between gap-[var(--oa-space-3)] border-t border-[var(--oa-divider)] py-2 first:border-t-0 max-[600px]:flex-wrap";

/** Shown only when the server has For you (Me.inbox). */
export function ForYouPrefs() {
  const prefs = usePrefs(true);
  const mutes = useMutes(true);
  // #2512 slice 3: no push key on the server: the browser column isn't shown.
  const key = usePushKey(true);
  if (!prefs.data || key.isPending) return null;
  // Design: no key on the server, or a browser that can't: the interrupt
  // settings have nothing to act on here.
  const available = !!key.data && pushSupported();
  return (
    <>
      <Levels prefs={prefs.data} pushKey={key.data ?? null} />
      <Interrupts prefs={prefs.data} unavailable={!available} />
      {mutes.data && mutes.data.items.length > 0 && (
        <Muted items={mutes.data.items} />
      )}
    </>
  );
}

/**
 * What a save sends: the whole prefs, in the browser's zone ("morning" and
 * quiet hours are in it). Design (#2674): while quiet hours wait under
 * "Coming later", they are never sent on.
 */
export const prefsToSave = (
  next: NotificationPrefs,
  live = INTERRUPTS_LIVE,
): NotificationPrefs => ({
  ...next,
  quietHours: live ? next.quietHours : null,
  timeZone: browserTimeZone(),
});

function useSave(live: boolean) {
  const save = useSavePrefs();
  return (next: NotificationPrefs) =>
    save.mutate(prefsToSave(next, live), {
      onError: () =>
        toast({ title: "Couldn't save. Try again.", tone: "danger" }),
    });
}

function Levels({
  prefs,
  pushKey,
}: {
  prefs: NotificationPrefs;
  pushKey: string | null;
}) {
  const supported = pushSupported();
  // Lifted here: the cell says it short, the row under it says it in full.
  const [perm, setPerm] = useState(permission);
  const blocked = supported && perm === "denied";
  // This browser's own row, from the list (S5, #2774).
  const subs = usePushSubscriptions(pushKey !== null && supported);
  const mine = thisSubscription(subs.data);
  const note =
    pushKey === null
      ? null
      : !supported
        ? PUSH_WORDS.cant
        : blocked
          ? PUSH_WORDS.blocked
          : null;
  const cantHere =
    pushKey === null ? null : !supported ? (
      <span data-push="unsupported" className={MUTED_SM}>
        {PUSH_WORDS.notAvailable}
      </span>
    ) : blocked ? (
      <span data-push="blocked" className={MUTED_SM}>
        {PUSH_WORDS.blockedHere}
      </span>
    ) : null;
  const th =
    "px-3.5 py-2.5 text-left text-[12.5px] font-semibold text-[var(--oa-text-muted)] max-[600px]:px-2.5";
  const td =
    "border-t border-[var(--oa-divider)] px-3.5 py-3 align-top max-[600px]:px-2.5";
  const sub = "mt-0.5 block text-[12.5px] text-[var(--oa-text-muted)]";
  return (
    <section aria-label="Where notifications reach you">
      <table
        data-notification-levels=""
        className="w-full border-separate border-spacing-0 overflow-hidden rounded-[12px] border border-[var(--oa-divider)] bg-[var(--oa-surface)] text-[14px]"
      >
        <thead>
          <tr>
            <td className={th} />
            <th scope="col" className={th}>
              In the app
            </th>
            <th scope="col" className={th}>
              This browser
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row" className={`${td} text-left font-normal`}>
              <b className="font-semibold">Needs you</b>
              <small className={sub}>
                Asks for you, and an agent that's stuck
              </small>
            </th>
            <td className={td}>Always</td>
            <td className={td}>
              {cantHere ?? (
                <NeedsYouBrowser
                  prefs={prefs}
                  pushKey={pushKey}
                  sub={sub}
                  mine={mine}
                  loading={subs.isPending && pushKey !== null && supported}
                  onRefused={setPerm}
                />
              )}
            </td>
          </tr>
          {note && (
            // Design: the full line goes under the row, across the table.
            <tr>
              <td
                colSpan={3}
                data-push-note=""
                className="border-t border-[var(--oa-divider)] bg-[var(--oa-surface-2,transparent)] px-3.5 py-2.5 text-[13px] text-[var(--oa-text-2)] max-[600px]:px-2.5"
              >
                {note}
              </td>
            </tr>
          )}
          <tr>
            <th scope="row" className={`${td} text-left font-normal`}>
              <b className="font-semibold">Updates</b>
              <small className={sub}>
                Replies, comments, shares, decisions, new versions
              </small>
            </th>
            <td className={td}>Always</td>
            <td className={td}>
              <UpdatesBrowser
                pushKey={pushKey}
                sub={sub}
                mine={cantHere ? undefined : mine}
              />
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

/**
 * #2512 slice 3 on S5 (#2774): "Needs you" in this browser. With a
 * subscription the switch is its own (needsYou, PATCH); without one, turning
 * it on asks the browser (from this click only) and subscribes. A server
 * with no push key leaves it off and disabled.
 */
function NeedsYouBrowser({
  prefs,
  pushKey,
  sub,
  mine,
  loading,
  onRefused,
}: {
  prefs: NotificationPrefs;
  pushKey: string | null;
  sub: string;
  mine: PushSubscriptionItem | undefined;
  loading: boolean;
  /** The browser's prompt answered: the row shows the blocked state. */
  onRefused: (p: NotificationPermission) => void;
}) {
  const save = useSavePrefs();
  const qc = useQueryClient();
  const patch = usePatchSubscription();
  const [busy, setBusy] = useState(false);
  const change = async (next: boolean) => {
    if (mine) {
      patch.mutate(
        { id: mine.id, body: { needsYou: next } },
        { onError: (e) => patchFailed(e, qc) },
      );
      return;
    }
    if (!next || !pushKey) return;
    setBusy(true);
    try {
      await turnOn(pushKey, thisBrowser());
      await qc.invalidateQueries({ queryKey: pushSubsKey });
      if (!prefs.needsYou.browser)
        await save.mutateAsync({
          ...prefs,
          needsYou: { ...prefs.needsYou, browser: true },
          timeZone: browserTimeZone(),
        });
    } catch (e) {
      if (e instanceof PermissionRefused) onRefused(e.state);
      else toast({ title: PUSH_WORDS.failed, tone: "danger" });
    } finally {
      setBusy(false);
    }
  };
  const on = mine ? mine.needsYou || mine.updates : false;
  return (
    <>
      <Switch
        label="Needs you in this browser"
        describedBy="oa-needs-browser"
        checked={mine?.needsYou === true}
        disabled={pushKey === null || busy || loading}
        onChange={(next) => void change(next)}
      />
      <small
        id="oa-needs-browser"
        className={sub}
        data-push={on ? "on" : "off"}
      >
        {pushKey === null
          ? PUSH_WORDS.noKey
          : mine && on
            ? PUSH_WORDS.onFor(mine.label ?? thisBrowser())
            : ""}
      </small>
    </>
  );
}

/** Updates in this browser: its own switch once the browser is subscribed. */
function UpdatesBrowser({
  pushKey,
  sub,
  mine,
}: {
  pushKey: string | null;
  sub: string;
  mine: PushSubscriptionItem | undefined;
}) {
  const qc = useQueryClient();
  const patch = usePatchSubscription();
  return (
    <>
      <Switch
        label="Updates in this browser"
        describedBy="oa-updates-browser"
        checked={mine?.updates === true}
        disabled={!mine}
        onChange={(next) =>
          mine &&
          patch.mutate(
            { id: mine.id, body: { updates: next } },
            { onError: (e) => patchFailed(e, qc) },
          )
        }
      />
      <small id="oa-updates-browser" className={sub}>
        {pushKey === null
          ? PUSH_WORDS.noKey
          : mine
            ? ""
            : PUSH_WORDS.turnOnFirst}
      </small>
    </>
  );
}

/** A switch that didn't save went back; a browser the server forgot is read again. */
function patchFailed(e: unknown, qc: QueryClient) {
  if ((e as { status?: number } | null)?.status === 404)
    void qc.invalidateQueries({ queryKey: pushSubsKey });
  toast({ title: "Couldn't save. Try again.", tone: "danger" });
}

/**
 * Design (#2512 slice 2 review): quiet hours, "Interrupt me for" and "On lock
 * screens" only matter once browser notifications ship (slice 3); the server
 * doesn't use them yet (no prefs route, no away status). Until then they show,
 * disabled, under one "Coming later" line (Design, #2674: they stay so until the away wiring ships).
 */
export const INTERRUPTS_LIVE = false;

function Interrupts({
  prefs,
  unavailable,
}: {
  prefs: NotificationPrefs;
  /** No push key on the server, or a browser that can't notify (Design). */
  unavailable: boolean;
}) {
  const live = INTERRUPTS_LIVE && !unavailable;
  const save = useSave(live);
  // Design (#2674): while "Coming later" is on, quiet hours are drawn off,
  // whatever the server stored.
  const quiet = live ? prefs.quietHours : null;
  const end = quiet?.end ?? QUIET_DEFAULT.end;
  return (
    <section
      aria-label="When to interrupt"
      aria-describedby={live ? undefined : "oa-interrupts-later"}
      className={BOX}
      data-interrupts={live ? "live" : "later"}
    >
      {!live && (
        <p id="oa-interrupts-later" className={`m-0 pb-2 ${muted}`}>
          {unavailable ? PUSH_WORDS.unavailableHere : "Coming later"}
        </p>
      )}
      <div className={ROW}>
        <div className="min-w-0">
          <b className="font-semibold" id="oa-quiet-label">
            Quiet hours
          </b>
          <p id="oa-quiet-hint" className={`m-0 ${muted}`}>
            Nothing interrupts between these times. It waits in the inbox. Your
            own agents see "away until {end}" and can plan around it.
          </p>
        </div>
        <div className="flex flex-none items-center gap-2">
          <Switch
            label="Quiet hours"
            describedBy="oa-quiet-hint"
            checked={quiet !== null}
            disabled={!live}
            onChange={(on) =>
              save({ ...prefs, quietHours: on ? QUIET_DEFAULT : null })
            }
          />
          <span className="w-[88px]">
            <OptionSelect
              label="Quiet hours start"
              value={quiet?.start ?? QUIET_DEFAULT.start}
              options={HALF_HOURS}
              disabled={!live || !quiet}
              onChange={(start) =>
                quiet && save({ ...prefs, quietHours: { ...quiet, start } })
              }
            />
          </span>
          <span aria-hidden="true">to</span>
          <span className="w-[88px]">
            <OptionSelect
              label="Quiet hours end"
              value={end}
              options={HALF_HOURS}
              disabled={!live || !quiet}
              onChange={(e) =>
                quiet && save({ ...prefs, quietHours: { ...quiet, end: e } })
              }
            />
          </span>
        </div>
      </div>
      <div className={ROW}>
        <div className="min-w-0">
          <b className="font-semibold">Interrupt me for</b>
          <p className={`m-0 ${muted}`}>
            What may send a browser notification. Everything else waits in the
            inbox.
          </p>
        </div>
        <span className="w-[240px] flex-none max-[600px]:w-full">
          <OptionSelect
            label="Interrupt me for"
            value={prefs.browserAllAsks ? "all" : "waiting"}
            disabled={!live}
            options={[
              { value: "waiting", label: "Waiting asks and approvals" },
              { value: "all", label: "Every ask put to me" },
            ]}
            onChange={(v) => save({ ...prefs, browserAllAsks: v === "all" })}
          />
        </span>
      </div>
      <div className={ROW}>
        <b className="font-semibold">On lock screens</b>
        <span className="w-[240px] flex-none max-[600px]:w-full">
          <OptionSelect
            label="On lock screens"
            value={prefs.lockScreenDetail ? "show" : "hide"}
            disabled={!live}
            options={[
              { value: "hide", label: "Hide details" },
              { value: "show", label: "Show details" },
            ]}
            onChange={(v) => save({ ...prefs, lockScreenDetail: v === "show" })}
          />
        </span>
      </div>
    </section>
  );
}

function Muted({ items }: { items: InboxMutes["items"] }) {
  const unmute = useUnmute();
  return (
    <section aria-labelledby="oa-muted" className={BOX}>
      <b id="oa-muted" className="block font-semibold">
        Muted
      </b>
      <p className={`m-0 ${muted}`}>
        Their asks still show in "For you". They don't interrupt.
      </p>
      <ul className="m-0 mt-1 list-none p-0">
        {items.map((m) => (
          <li key={`${m.kind}:${m.id}`} className={ROW}>
            <span className="min-w-0 break-words">
              {m.kind === "page" ? `"${m.name}"` : m.name}{" "}
              <span className="text-[var(--oa-text-muted)]">{m.kind}</span>
            </span>
            <Button
              variant="outline"
              size="sm"
              aria-label={`Unmute ${m.name}`}
              onClick={() =>
                unmute.mutate(
                  { kind: m.kind, id: m.id },
                  {
                    onError: (e) =>
                      toast({
                        title: muteErrorCopy(e, "unmute"),
                        tone: "danger",
                      }),
                  },
                )
              }
            >
              Unmute
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
