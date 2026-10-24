import { AUTH } from "@oa/shared";
import { brand } from "@oa/ui/brand";
import { Button } from "@oa/ui/shadcn";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useCallback, useState } from "react";
import { useAuthProviders } from "../api/auth";
import {
  type AuthProviders,
  SIGN_IN_PAGE,
  type SignInError,
  SignInErrorSchema,
} from "../api/contract";
import { safeNext } from "../auth/safeNext";
import { Notice } from "../layout/Notice";
import { useDocumentTitle, useInstanceName } from "../layout/useDocumentTitle";
import { CodeSignIn } from "./CodeSignIn";

/** Light and dark variants of one brand image; CSS shows the matching one. */
function Themed({
  light,
  dark,
  className,
}: {
  light: string;
  dark: string;
  className?: string;
}) {
  return (
    <>
      <img
        className={`oa-lt ${className ?? ""}`}
        src={light}
        alt=""
        aria-hidden="true"
      />
      <img
        className={`oa-dk ${className ?? ""}`}
        src={dark}
        alt=""
        aria-hidden="true"
      />
    </>
  );
}

/** The bare mark (paths from the brand logo): frame in text ink, accent in the brand accent. */
function Mark({ className }: { className: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="var(--oa-text)"
        d="M22 2H5a3 3 0 0 0-3 3v17l4 4V6h20zM10 30h17a3 3 0 0 0 3-3V10l-4-4v20H6z"
      />
      <path
        fill="var(--oa-accent)"
        d="M22 2h5a3 3 0 0 1 3 3v5zM2 22v5a3 3 0 0 0 3 3h5zM11 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z"
      />
    </svg>
  );
}

/**
 * Split brand panel: pitch on the left, sign-in form on the right. `hosted` is
 * null until GET AUTH.providers answers, so an unknown instance never claims
 * to be self-hosted.
 */
function Shell({
  hosted,
  children,
}: {
  hosted: boolean | null;
  children?: ReactNode;
}) {
  return (
    <div className="oa-split">
      <section className="oa-split-brand">
        <div className="oa-split-logo">
          <Themed light={brand.logo} dark={brand.logoDark} />
        </div>
        <div className="oa-split-pitch">
          <h2>Where any AI agent publishes for your team.</h2>
          <p>
            Pages, docs, code and PDFs, private by default and shared when you
            choose.
          </p>
        </div>
        {hosted !== null && (
          <small className="oa-split-foot">
            {hosted ? "Hosted by Open Artifacts" : "Self-hosted on Cloudflare"}
          </small>
        )}
        <Mark className="oa-split-mark" />
      </section>
      <section className="oa-split-form">
        <div className="oa-split-formbox">
          <Mark className="oa-split-formmark" />
          {children}
        </div>
      </section>
    </div>
  );
}

/** Copy for a refused redirect sign-in. Unknown values never reach here. */
const errorCopy = (error: SignInError, name: string, domain?: string) => {
  switch (error) {
    case "tenant":
      return domain
        ? `That Google account isn't part of ${name}. Use your ${domain} account.`
        : `That Google account isn't part of ${name}. Use your work Google account.`;
    case "identity_conflict":
      return "This email is linked to a different Google account. Ask your admin to reset the link.";
    case "removed":
      return `Your access to ${name} was removed. Ask your admin if this is a mistake.`;
    case "no_access":
      return "You don't have access yet. Ask your admin to invite you.";
    case "expired":
      return "Sign-in took too long. Try again.";
    default:
      return "Sign-in didn't work. Try again.";
  }
};

/**
 * Today's page: the self-hosted install and every Access-mode instance. An
 * older server (or one that cannot answer) lands here too.
 */
function AccessSignIn({ failed }: { failed: boolean }) {
  const name = useInstanceName();
  return (
    <>
      <h1>Sign in</h1>
      <p className="oa-split-sub">Use your work email to open {name}.</p>
      {failed && (
        <Notice tone="danger" title="Sign-in didn't finish.">
          The login link expired or was cancelled. Try again.
        </Notice>
      )}
      <Button asChild className="oa-split-btn">
        <a href={AUTH.login}>
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="7.5" cy="15.5" r="4.5" />
            <path d="m10.7 12.3 9.3-9.3M16 7l3 3M14 9l2 2" />
          </svg>
          Continue with Cloudflare Access
        </a>
      </Button>
      <p className="oa-note">
        You'll confirm your email with a one-time PIN or your organization's
        login.
      </p>
    </>
  );
}

/** A button that reads as a link inside a sentence. */
const INLINE_LINK = {
  color: "var(--oa-accent)",
  textDecoration: "underline",
} as const;

/**
 * Google signs the company in; emailed codes cover the trial and invited
 * guests (Design D8, option C). With Google on, the code steps live on their
 * own page, `?method=code`, reached from the guest row; `next` is already
 * through `safeNext` and every link here carries it.
 */
function HostedSignIn({
  providers,
  error,
  next,
  method,
}: {
  providers: AuthProviders;
  error: SignInError | null;
  next: string;
  method?: "code";
}) {
  const name = useInstanceName();
  const [step, setStep] = useState<"email" | "code">("email");
  const onStep = useCallback((next: "email" | "code") => setStep(next), []);
  // The provider's start must be a same-origin path: a hostile one drops Google.
  const google = providers.providers.find(
    (p): p is Extract<typeof p, { id: "google" }> =>
      p.id === "google" && safeNext(p.start) === p.start,
  );
  const email = providers.providers.find((p) => p.id === "email");
  const domain = google?.domains[0];
  const googleHref = google
    ? `${google.start}?next=${encodeURIComponent(next)}`
    : undefined;
  const banner = error && (
    <Notice tone="danger">{errorCopy(error, name, domain)}</Notice>
  );

  if (!google && !email)
    return (
      <>
        <h1>Sign in to {name}</h1>
        <p className="oa-split-sub">
          Sign-in isn't set up yet. Ask your admin.
        </p>
      </>
    );

  // Trial: no Google yet, so codes are the main way in.
  if (!google && email)
    return (
      <>
        <h1>Sign in to {name}</h1>
        {banner}
        {step === "email" && (
          <p className="oa-split-sub">
            We'll email you an 8-digit sign-in code.
          </p>
        )}
        <CodeSignIn
          next={next}
          turnstileSiteKey={email.turnstileSiteKey}
          onStep={onStep}
        />
        {step === "email" && (
          <p className="oa-note">
            {name} is trying Open Artifacts. Codes go to work addresses and
            invited guests. Once your admin connects Google, you'll sign in with
            Google instead.
          </p>
        )}
      </>
    );

  const guests = email?.guests ? email : undefined;

  // The guest code page: email step, then the code step.
  if (guests && method === "code")
    return (
      <>
        {step === "email" && (
          <p style={{ margin: "0 0 12px", fontSize: 13 }}>
            <Link to={SIGN_IN_PAGE as string} search={{ next }}>
              <span aria-hidden="true">‹ </span>Back
            </Link>
          </p>
        )}
        <h1>
          {step === "email" ? "Get a sign-in code" : `Sign in to ${name}`}
        </h1>
        {banner}
        {step === "email" && (
          <p className="oa-split-sub">
            Use the email address the link was shared with.
          </p>
        )}
        <CodeSignIn
          next={next}
          turnstileSiteKey={guests.turnstileSiteKey}
          googleHref={googleHref}
          onStep={onStep}
          variant="guest"
        />
        {step === "email" && (
          <p className="oa-note">
            {domain
              ? `Have ${/^[aeiou]/i.test(domain) ? "an" : "a"} ${domain} account?`
              : "Have a work Google account?"}{" "}
            <a href={googleHref} style={INLINE_LINK}>
              Continue with Google
            </a>
            .{domain ? ` Codes don't go to ${domain} addresses.` : ""}
          </p>
        )}
      </>
    );

  // Google only: one button; guests get their own row.
  return (
    <>
      <h1>Sign in to {name}</h1>
      {banner}
      <p className="oa-split-sub">
        {domain
          ? `Use your ${domain} Google account.`
          : "Use your Google account."}
      </p>
      <Button asChild className="oa-split-btn">
        <a href={googleHref}>Continue with Google</a>
      </Button>
      {guests && (
        <div
          style={{
            marginTop: 24,
            paddingTop: 16,
            borderTop: "1px solid var(--oa-divider)",
          }}
        >
          <p style={{ margin: "0 0 12px", fontSize: 13 }}>
            <strong>Invited as a guest?</strong> If someone shared an artifact
            with your email, use a code.
          </p>
          <Button asChild variant="outline" className="oa-split-btn">
            <Link to={SIGN_IN_PAGE as string} search={{ method: "code", next }}>
              Get a sign-in code
            </Link>
          </Button>
        </div>
      )}
    </>
  );
}

/**
 * `/sign-in`. `error` is a refused redirect sign-in: it is parsed against the
 * known list (an unknown value shows the "failed" copy and is never rendered).
 * `next` is where the person was going and only travels through `safeNext`.
 */
export function SignIn({
  error,
  next,
  method,
}: {
  error?: string;
  next?: string;
  method?: string;
}) {
  useDocumentTitle("Sign in");
  const providers = useAuthProviders();
  const parsed =
    error !== undefined ? SignInErrorSchema.safeParse(error) : null;
  const shownError = parsed ? (parsed.success ? parsed.data : "failed") : null;

  if (!providers.data)
    // An older server or a network failure: today's page. Still asking: an
    // empty panel, never a claim about the mode that may change in a moment.
    return providers.isError ? (
      <Shell hosted={false}>
        <AccessSignIn failed={error !== undefined} />
      </Shell>
    ) : (
      <Shell hosted={null} />
    );
  const data = providers.data;
  if (data.mode === "access")
    return (
      <Shell hosted={false}>
        <AccessSignIn failed={error !== undefined} />
      </Shell>
    );
  return (
    <Shell hosted>
      <HostedSignIn
        providers={data}
        error={shownError}
        next={safeNext(next)}
        method={method === "code" ? "code" : undefined}
      />
    </Shell>
  );
}
