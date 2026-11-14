/**
 * Settings › Notifications for For you (#2512 slice 2), Design's screen 4:
 * where each level reaches you, quiet hours, what may interrupt, lock
 * screens, and the muted list. Prefs are R.meNotificationPrefs (PUT whole);
 * mutes are R.meInboxMutes. The browser switch is slice 3: a stub for now.
 */
import type { InboxMutes, NotificationPrefs } from "@oa/shared";
import { Button } from "@oa/ui/shadcn";
import {
  browserTimeZone,
  useMutes,
  usePrefs,
  useSavePrefs,
  useUnmute,
} from "../foryou/api";
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

/** "Chrome on this Mac": this browser, for the browser column. */
export function thisBrowser(ua = navigator.userAgent): string {
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "this browser";
  const device = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "phone"
        : /Mac OS X|Macintosh/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "PC"
            : "computer";
  return `${browser} on this ${device}`;
}

const BOX =
  "rounded-[12px] border border-[var(--oa-divider)] bg-[var(--oa-surface)] px-3.5 py-3 text-[length:var(--oa-text-sm)]";
const ROW =
  "flex items-center justify-between gap-[var(--oa-space-3)] border-t border-[var(--oa-divider)] py-2 first:border-t-0 max-[600px]:flex-wrap";

/** Shown only when the server has For you (Me.inbox). */
export function ForYouPrefs() {
  const prefs = usePrefs(true);
  const mutes = useMutes(true);
  if (!prefs.data) return null;
  return (
    <>
      <Levels prefs={prefs.data} />
      <Interrupts prefs={prefs.data} />
      {mutes.data && mutes.data.items.length > 0 && (
        <Muted items={mutes.data.items} />
      )}
    </>
  );
}

/** Save the whole prefs, in the browser's zone ("morning" and quiet hours are in it). */
function useSave() {
  const save = useSavePrefs();
  return (next: NotificationPrefs) =>
    save.mutate(
      { ...next, timeZone: browserTimeZone() },
      {
        onError: () =>
          toast({ title: "Couldn't save. Try again.", tone: "danger" }),
      },
    );
}

/** The browser column's switch is slice 3: it says so and changes nothing. */
const browserStub = () =>
  toast({ title: "Browser notifications are coming soon.", tone: "neutral" });

function Levels({ prefs }: { prefs: NotificationPrefs }) {
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
                Asks, approvals, a stuck agent, a failed payment
              </small>
            </th>
            <td className={td}>Always</td>
            <td className={td}>
              <Switch
                label="Needs you in this browser"
                describedBy={
                  prefs.needsYou.browser ? "oa-needs-browser" : undefined
                }
                checked={prefs.needsYou.browser}
                onChange={browserStub}
              />
              {prefs.needsYou.browser && (
                <small id="oa-needs-browser" className={sub}>
                  On for {thisBrowser()}
                </small>
              )}
            </td>
          </tr>
          <tr>
            <th scope="row" className={`${td} text-left font-normal`}>
              <b className="font-semibold">Updates</b>
              <small className={sub}>
                Replies, comments, shares, decisions, new versions
              </small>
            </th>
            <td className={td}>Always</td>
            <td className={td}>
              {/* v1: updates never reach the browser (updates.browser is fixed false). */}
              <Switch
                label="Updates in this browser"
                describedBy="oa-updates-browser"
                checked={false}
                disabled
                onChange={() => {}}
              />
              <small id="oa-updates-browser" className={sub}>
                Not in this version
              </small>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

function Interrupts({ prefs }: { prefs: NotificationPrefs }) {
  const save = useSave();
  const quiet = prefs.quietHours;
  const end = quiet?.end ?? QUIET_DEFAULT.end;
  return (
    <section aria-label="When to interrupt" className={BOX}>
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
            onChange={(on) =>
              save({ ...prefs, quietHours: on ? QUIET_DEFAULT : null })
            }
          />
          <span className="w-[88px]">
            <OptionSelect
              label="Quiet hours start"
              value={quiet?.start ?? QUIET_DEFAULT.start}
              options={HALF_HOURS}
              disabled={!quiet}
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
              disabled={!quiet}
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
              onClick={() => unmute.mutate({ kind: m.kind, id: m.id })}
            >
              Unmute
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
