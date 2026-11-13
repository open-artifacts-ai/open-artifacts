import { Button, Input, Label } from "@oa/ui/shadcn";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { requestCode, verifyCode } from "../api/auth";
import { ApiClientError } from "../api/client";
import {
  CODE_POLICY,
  type CodeRateLimitedDetails,
  type CodeRequest,
  normalizeCode,
} from "../api/contract";
import { errorCopy } from "../api/errorCopy";
import { safeNext } from "../auth/safeNext";
import { Turnstile, type TurnstileHandle } from "./Turnstile";

/** The server's `codeLength` when it is an integer in 4..12, else `CODE_POLICY.length`. */
export const codeLengthOf = (length: number): number =>
  Number.isInteger(length) && length >= 4 && length <= 12
    ? length
    : CODE_POLICY.length;

/**
 * A code is complete when `normalizeCode` leaves exactly `length` digits.
 * The length is validated before it reaches the pattern.
 */
export const isCompleteCode = (raw: string, length: number): boolean =>
  new RegExp(`^\\d{${codeLengthOf(length)}}$`).test(normalizeCode(raw));

/** A 429's Retry-After, clamped to 1 s..1 h so the hold timer stays in range. */
const clampRetry = (seconds: number) =>
  Math.min(3600, Math.max(1, Number.isFinite(seconds) ? seconds : 3600));

/** Control, delimiter and bidi characters: an address the field never accepts. */
const unsafeChar = (c: string) => {
  const n = c.charCodeAt(0);
  return (
    n <= 0x1f ||
    n === 0x7f ||
    (n >= 0x200b && n <= 0x200f) ||
    (n >= 0x202a && n <= 0x202e) ||
    (n >= 0x2066 && n <= 0x2069)
  );
};
const EMAIL =
  /^[^\s@,;:"<>()[\]\\]+@[^\s@,;:"<>()[\]\\]+\.[^\s@,;:"<>()[\]\\]{2,}$/;

/** What the field says before any request: a shape, never whether the address is known. */
const emailProblem = (raw: string): string | null =>
  raw.length > 254 || [...raw].some(unsafeChar) || !EMAIL.test(raw)
    ? "Enter a valid email address."
    : null;

/** "1234 5678": the field's own hint, in the two groups the code is drawn in. */
const picture = (length: number) => {
  const half = Math.ceil(length / 2);
  return `${"1234".repeat(2).slice(0, half)} ${"5678".repeat(2).slice(0, length - half)}`;
};

/** A button that reads as a link inside a sentence. */
const LINK = {
  background: "none",
  border: 0,
  padding: 0,
  font: "inherit",
  color: "var(--oa-accent)",
  textDecoration: "underline",
  cursor: "pointer",
} as const;

const PENDING_FALLBACK = "Couldn't send the code. Try again.";
const CODE_FALLBACK = "That code didn't work. Check it and try again.";
/** Design D8: generic copy, no lock state; Retry-After only holds the buttons. */
const TOO_MANY_CODES =
  "Too many codes for this address. Wait a bit, then try again.";
const TOO_MANY_TRIES = "Too many tries. Wait a bit, then request a new code.";
const CODE_EXPIRED = "Too many tries, or the code expired. Request a new code.";

/**
 * 503 from a code route: emailed codes are off (`code_unavailable`). The code
 * isn't in the shared enum yet, so the client reads it as `internal`; the
 * status is what counts.
 */
const codesOff = (e: unknown) =>
  e instanceof ApiClientError && e.status === 503 && e.code !== "cpu_limit";

/** `details.reason` on 401 from the code verify route (`CodeVerifyFailureDetails`); the UI shows no try counts. */
type VerifyFailure = "invalid_code" | "expired" | "no_pending";

const verifyFailure = (details: unknown): VerifyFailure | null => {
  if (!details || typeof details !== "object") return null;
  const { reason } = details as { reason?: unknown };
  return reason === "invalid_code" ||
    reason === "expired" ||
    reason === "no_pending"
    ? reason
    : null;
};

/** `details` on 429 from the code routes (`CodeRateLimitedDetails`). */
const rateLimited = (details: unknown): CodeRateLimitedDetails | null => {
  if (!details || typeof details !== "object") return null;
  const { retryAfter, scope } = details as {
    retryAfter?: unknown;
    scope?: unknown;
  };
  return typeof retryAfter === "number" && (scope === "email" || scope === "ip")
    ? { retryAfter, scope }
    : null;
};

/** Where the code request left us: the address, and the policy the server applied. */
type Pending = {
  email: string;
  maskedEmail: string;
  expiresIn: number;
  resendAfter: number;
  codeLength: number;
};

/**
 * The emailed-code steps: the address, then the 8-digit code. `next` is
 * already safe (SignIn ran it through `safeNext`) and travels on the request;
 * the address that signs in is the one in the URL the server hands back, never
 * the prop. Every refusal has one copy, and none of it says whether an address
 * can sign in.
 */
export function CodeSignIn({
  next,
  turnstileSiteKey,
  googleHref,
  onStep,
  variant = "trial",
}: {
  /** Already through `safeNext`. */
  next: string;
  /** Cloudflare's key; no key, no widget and no token. */
  turnstileSiteKey?: string;
  /** Where "Continue with Google" goes, when Google is on: the codes-off copy points there. */
  googleHref?: string;
  /** "code" once a code is pending: the page swaps its heading and hides Back and the footnote. */
  onStep?: (step: "email" | "code") => void;
  /** "trial": codes are the main way in. "guest": the `?method=code` page next to Google. */
  variant?: "trial" | "guest";
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A 429's reason, shown as an inline warning for as long as the buttons are held. */
  const [notice, setNotice] = useState<string | null>(null);
  const [slotError, setSlotError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  /** A 429's Retry-After: every send and verify button holds until then. */
  const [held, setHeld] = useState(false);
  /** When the resend button enables (ms since epoch), so a slow tick cannot drift. */
  const resendAt = useRef(0);
  const widget = useRef<TurnstileHandle>(null);
  const emailField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    onStep?.(pending ? "code" : "email");
  }, [pending, onStep]);

  // The resend countdown the server set on the last request.
  const counting = resendIn > 0;
  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(
      () =>
        setResendIn(
          Math.max(0, Math.ceil((resendAt.current - Date.now()) / 1000)),
        ),
      250,
    );
    return () => clearInterval(timer);
  }, [counting]);

  const holdTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(holdTimer.current), []);

  /** Holds every send and verify button with its reason; both clear, silently, after Retry-After. */
  const hold = (seconds: number, reason: string) => {
    clearTimeout(holdTimer.current);
    setError(null);
    setNotice(reason);
    setHeld(true);
    holdTimer.current = setTimeout(() => {
      setHeld(false);
      setNotice(null);
    }, clampRetry(seconds) * 1000);
  };

  /** A token is single-use: drop it and reset the widget after every request. */
  const spendToken = () => {
    setToken(null);
    widget.current?.reset();
  };

  const send = async (address: string) => {
    setError(null);
    setSlotError(null);
    setBusy(true);
    const body: CodeRequest = {
      email: address,
      // Already safe; the guard again so this request never depends on the caller.
      next: safeNext(next),
      ...(token ? { turnstileToken: token } : {}),
    };
    try {
      const res = await requestCode(body);
      spendToken();
      setPending({
        email: address,
        maskedEmail: res.maskedEmail,
        expiresIn: res.expiresIn,
        resendAfter: res.resendAfter,
        codeLength: codeLengthOf(res.codeLength),
      });
      setCode("");
      resendAt.current = Date.now() + res.resendAfter * 1000;
      setResendIn(res.resendAfter);
    } catch (e) {
      spendToken();
      const limit = e instanceof ApiClientError ? rateLimited(e.details) : null;
      if (limit)
        hold(
          limit.retryAfter,
          limit.scope === "ip" ? TOO_MANY_TRIES : TOO_MANY_CODES,
        );
      else if (
        codesOff(e) ||
        (e instanceof ApiClientError && e.code === "not_found")
      )
        setError(googleHref ? CODES_OFF_GOOGLE : CODES_OFF);
      else if (e instanceof ApiClientError && e.code === "turnstile_required")
        setSlotError(errorCopy(e, PENDING_FALLBACK));
      else if (
        e instanceof ApiClientError &&
        e.code === "bad_request" &&
        fieldOf(e.details) === "email"
      )
        setError("Enter a valid email address.");
      else setError(errorCopy(e, PENDING_FALLBACK));
    } finally {
      setBusy(false);
    }
  };

  const onSubmitEmail = (event: FormEvent) => {
    event.preventDefault();
    const address = email.trim();
    const problem = emailProblem(address);
    setError(problem);
    setSlotError(null);
    if (problem || held) return;
    void send(address);
  };

  const onSubmitCode = async (event: FormEvent) => {
    event.preventDefault();
    if (!pending || held) return;
    setError(null);
    if (!isCompleteCode(code, pending.codeLength)) {
      setError(`Enter all ${pending.codeLength} digits.`);
      return;
    }
    setBusy(true);
    try {
      const verified = await verifyCode(normalizeCode(code));
      // The server's address, through the same guard: a hostile `next` never leaves the app.
      location.assign(safeNext(verified.next));
    } catch (e) {
      const failure =
        e instanceof ApiClientError ? verifyFailure(e.details) : null;
      const limit = e instanceof ApiClientError ? rateLimited(e.details) : null;
      if (codesOff(e)) {
        // Codes went off mid-flow: the email step says so, Google stays a way in.
        backToEmail();
        setError(googleHref ? CODES_OFF_GOOGLE : CODES_OFF);
        return;
      }
      if (e instanceof ApiClientError && e.status === 401 && failure) {
        if (failure === "no_pending") {
          // No (or a stale) request in this browser: back to the address, kept.
          backToEmail();
          setError("Start again: enter your email to get a code.");
          return;
        }
        setCode("");
        setError(
          failure === "expired" ? CODE_EXPIRED : CODE_FALLBACK, // Design: no try counts
        );
        return;
      }
      if (limit) {
        hold(limit.retryAfter, TOO_MANY_TRIES);
        return;
      }
      setError(errorCopy(e, CODE_FALLBACK));
    } finally {
      setBusy(false);
    }
  };

  /** The address step again, with the typed address kept. */
  const backToEmail = () => {
    setPending(null);
    setCode("");
    resendAt.current = 0;
    setResendIn(0);
  };

  const resend = () => {
    if (!pending || busy || held) return;
    void send(pending.email);
  };

  const startOver = () => {
    backToEmail();
    setError(null);
    setSlotError(null);
    emailField.current?.focus();
  };

  // One slot per request step (the widget remounts with each step, a fresh token each time).
  const slot = (
    <div style={{ marginTop: 12 }}>
      {turnstileSiteKey && (
        <Turnstile ref={widget} siteKey={turnstileSiteKey} onToken={setToken} />
      )}
      {slotError && (
        <p role="alert" style={{ margin: "8px 0 0", fontSize: 13 }}>
          {slotError}
        </p>
      )}
    </div>
  );

  if (pending) {
    const minutes = Math.round(pending.expiresIn / 60);
    return (
      <>
        <h2
          style={{
            margin: "24px 0 8px",
            fontSize: 20,
            fontWeight: 600,
            letterSpacing: "-0.01em",
          }}
        >
          Check your email
        </h2>
        <p style={{ margin: "0 0 4px", color: "var(--oa-text-2)" }}>
          If {pending.maskedEmail} can log in here, we sent it a code.
        </p>
        <p
          style={{
            margin: "0 0 20px",
            fontSize: 13,
            color: "var(--oa-text-muted)",
          }}
        >
          The code works for {minutes} minutes.
        </p>
        <form onSubmit={onSubmitCode} noValidate aria-busy={busy || undefined}>
          <Label htmlFor="signin-code">Code</Label>
          <Input
            id="signin-code"
            name="code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder={picture(pending.codeLength)}
            autoFocus
            spellCheck={false}
            style={{
              marginTop: 6,
              textAlign: "center",
              fontVariantNumeric: "tabular-nums",
              letterSpacing: "0.35em",
              fontSize: 18,
            }}
          />
          {error && (
            <p role="alert" style={{ margin: "8px 0 0", fontSize: 13 }}>
              {error}
            </p>
          )}
          {notice && <HeldNotice>{notice}</HeldNotice>}
          {slot}
          <Button
            type="submit"
            className="oa-split-btn"
            style={{ marginTop: 16 }}
            disabled={busy || held}
            aria-describedby={notice ? HELD_ID : undefined}
          >
            Verify
          </Button>
        </form>
        <p className="oa-note">
          No email? Check spam, or ask the person who shared it.{" "}
          {resendIn > 0 ? (
            // Muted text while the timer runs: nothing to click yet.
            <span style={{ color: "var(--oa-text-muted)" }}>
              Resend in {resendIn}s
            </span>
          ) : (
            <button
              type="button"
              style={LINK}
              onClick={resend}
              disabled={busy || held}
            >
              Resend code
            </button>
          )}
          <span aria-hidden="true"> · </span>
          <button type="button" style={LINK} onClick={startOver}>
            Use a different email
          </button>
        </p>
      </>
    );
  }

  return (
    <form onSubmit={onSubmitEmail} noValidate aria-busy={busy || undefined}>
      <Label htmlFor="signin-email">
        {variant === "guest" ? "Email" : "Work email"}
      </Label>
      {variant === "trial" && (
        <p id="signin-email-hint" style={{ margin: "4px 0 8px", fontSize: 13 }}>
          Or the email you were invited with.
        </p>
      )}
      <Input
        id="signin-email"
        name="email"
        type="email"
        ref={emailField}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        autoComplete="email"
        placeholder="you@company.com"
        aria-describedby={variant === "trial" ? "signin-email-hint" : undefined}
        style={variant === "guest" ? { marginTop: 6 } : undefined}
        spellCheck={false}
      />
      {error && (
        <p role="alert" style={{ margin: "8px 0 0", fontSize: 13 }}>
          {error}
        </p>
      )}
      {notice && <HeldNotice>{notice}</HeldNotice>}
      {slot}
      <Button
        type="submit"
        className="oa-split-btn"
        style={{ marginTop: 16 }}
        disabled={busy || held}
        aria-describedby={notice ? HELD_ID : undefined}
      >
        {variant === "guest" ? "Send code" : "Email me a code"}
      </Button>
    </form>
  );
}

/** Codes are off on this instance: the copy depends on whether Google is a way in. */
const CODES_OFF =
  "Login by email code isn't available right now. Ask your admin for help.";
const CODES_OFF_GOOGLE =
  "Login by email code isn't available right now. Use Continue with Google, or ask your admin.";

/** `details.field`, when the server named one. */
function fieldOf(details: unknown): string | null {
  if (!details || typeof details !== "object") return null;
  const field = (details as { field?: unknown }).field;
  return typeof field === "string" ? field : null;
}

const HELD_ID = "signin-held";

/** The inline warning for a 429: why the button is disabled, announced politely. */
function HeldNotice({ children }: { children: string }) {
  return (
    <p
      id={HELD_ID}
      role="status"
      aria-live="polite"
      data-tone="warning"
      style={{
        display: "flex",
        gap: 8,
        alignItems: "flex-start",
        margin: "8px 0 0",
        padding: "8px 10px",
        borderRadius: 6,
        fontSize: 13,
        color: "var(--oa-warning)",
        background: "var(--oa-warning-soft)",
      }}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        width="16"
        height="16"
        fill="currentColor"
        style={{ flex: "none", marginTop: 1 }}
      >
        <path d="M8 1.5a1 1 0 0 1 .87.5l6.5 11.25A1 1 0 0 1 14.5 14.75h-13a1 1 0 0 1-.87-1.5L7.13 2A1 1 0 0 1 8 1.5Zm0 4a.75.75 0 0 0-.75.75v3.5a.75.75 0 0 0 1.5 0v-3.5A.75.75 0 0 0 8 5.5Zm0 6.25a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8Z" />
      </svg>
      <span>{children}</span>
    </p>
  );
}
