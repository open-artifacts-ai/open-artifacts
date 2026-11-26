import { AUTH } from "@oa/shared";
import { brand } from "@oa/ui/brand";
import { Button } from "@oa/ui/shadcn";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useState } from "react";
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
import { useCodeLink } from "./codeLink";

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

/**
 * OA Product (#2590 G2), word for word. (a) needs_code: Google couldn't
 * vouch for the shared address ({email} is the masked address the link
 * names); codes on, then off. (b) no_access from Google: they used another
 * account (no link, so no address).
 */
export const needsCode = (email: string) =>
  `Google couldn't confirm ${email}. We'll email a code to that address. After that, Google works.`;
/**
 * OA Product: needs_code with codes off. The server sends no link then (no
 * cookie, so no address): this line, and Try another account.
 */
export const NEEDS_CODE_NO_CODES =
  "Google couldn't confirm that address. Ask whoever invited you or shared this page to use your Gmail or Google Workspace address.";
export const WRONG_ACCOUNT =
  "That Google account doesn't have access. Log in with the account for the address this page was shared with, or get a code at that address.";
/** OA Product: (b) with codes off. */
export const WRONG_ACCOUNT_NO_CODES =
  "That Google account doesn't have access. Log in with the account for the address this page was shared with.";
/** #3029: under the Google button on the plain sign-in page. */
export const INVITED_HELP =
  "Invited? Use the Google account your invite went to. Can't get in? Ask the person who invited you.";

/**
 * #2590 G2 (b) is for share recipients: the server can't tell them apart,
 * so a page link in `next` (/a/<id>) stands for it. Anything else keeps the
 * member line.
 */
const isPageLink = (next: string) => /^\/a\/[^/?#]+/.test(next);
/**
 * OA Product (#2590 G2): needs_code without link=1, or a link that's gone
 * (404): the usual sign-in, with this line above it.
 */
export const NEEDS_CODE = "That took too long. Start again.";
/** The invite's time ran out: the server redirects with error=invite_expired. */
export const INVITE_EXPIRED =
  "This invite has expired. Ask whoever invited you to send a new one.";

/**
 * #3029 item 2: the dashboard had no route for the address asked (a
 * mistyped /invite/x, /connect, /docs). Copy checked by OA Product.
 */
export const DEAD_LINK =
  "That link doesn't go to a page here. Log in to go to your Library.";

/** Copy for a refused redirect sign-in. Unknown values never reach here. */
const errorCopy = (
  error: SignInError,
  name: string,
  domain?: string,
  via?: "access" | "google",
) => {
  switch (error) {
    case "tenant":
      return domain
        ? `That Google account isn't part of ${name}. Use your ${domain} account.`
        : `That Google account isn't part of ${name}. Use your work Google account.`;
    case "identity_conflict":
      return "This email is linked to a different Google account. Ask your admin to reset the link.";
    case "removed":
      return `Your access to ${name} was removed. Ask your admin if this is a mistake.`;
    // `via` says which sign-in refused (#799); an older server sends neither.
    case "no_access":
      return via === "access"
        ? "Your organization's single sign-on didn't let you in. Ask your admin for access, then try again."
        : via === "google"
          ? "This Google account doesn't have access here yet. Ask an admin to invite you, or log in with another Google account."
          : "You don't have access here yet. Ask an admin to invite you, then try again.";
    case "expired":
      return "Login took too long. Try again.";
    case "needs_code":
      return NEEDS_CODE;
    case "invite_expired":
      return INVITE_EXPIRED;
    default:
      return "Login didn't work. Try again.";
  }
};

/** The key glyph on the Cloudflare Access button. */
function KeyIcon() {
  return (
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
  );
}

/**
 * A provider's start with `next` added to whatever query it already has
 * ("/auth/login?via=access" keeps `via`). Same-origin path out.
 */
const startHref = (start: string, next: string) => {
  const u = new URL(start, "https://oa.invalid");
  u.searchParams.set("next", next);
  return `${u.pathname}${u.search}`;
};

/**
 * Today's page: the self-hosted install and every Access-mode instance. An
 * older server (or one that cannot answer) lands here too.
 */
function AccessSignIn({ failed }: { failed: boolean }) {
  const name = useInstanceName();
  return (
    <>
      <h1>Log in</h1>
      <p className="oa-split-sub">Use your work email to open {name}.</p>
      {failed && (
        <Notice tone="danger" title="Login didn't finish.">
          The login link expired or was cancelled. Try again.
        </Notice>
      )}
      <Button asChild className="oa-split-btn">
        <a href={AUTH.login}>
          <KeyIcon />
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
  via,
  link,
  deadLink,
}: {
  providers: AuthProviders;
  error: SignInError | null;
  /** #3029: `next` named a path with no route; it is already "/". */
  deadLink?: boolean;
  next: string;
  /** #2590 G2: needs_code came with link=1 (the server holds the address). */
  link?: boolean;
  method?: "code";
  /** Which sign-in refused a no_access. */
  via?: "access" | "google";
}) {
  const name = useInstanceName();
  const [step, setStep] = useState<"email" | "code">("email");
  // #2590 G2 (b): "Email me a code" opens the code form.
  const [codeForm, setCodeForm] = useState(false);
  const onStep = useCallback((next: "email" | "code") => setStep(next), []);
  // A provider's start must be a same-origin path: a hostile one is dropped.
  const google = providers.providers.find(
    (p): p is Extract<typeof p, { id: "google" }> =>
      p.id === "google" && safeNext(p.start) === p.start,
  );
  const access = providers.providers.find(
    (p): p is Extract<typeof p, { id: "access" }> =>
      p.id === "access" && safeNext(p.start) === p.start,
  );
  const email = providers.providers.find((p) => p.id === "email");
  // #2590 G2: the masked address the link names (PROVISIONAL, codeLink.ts).
  const navigate = useNavigate();
  const wantLink = error === "needs_code" && link === true && !!email;
  const linkQuery = useCodeLink(wantLink);
  const linked = wantLink ? linkQuery : null;
  // No link any more (404): start over, at the sign-in page.
  const startOver = useCallback(
    () =>
      void navigate({
        to: SIGN_IN_PAGE as string,
        search: { next } as never,
        replace: true,
      }),
    [navigate, next],
  );
  // The link is gone (404) or can't be read: the usual page, with "That took
  // too long. Start again." above it (needs_code without link=1).
  const linkGone = wantLink && (linkQuery.data === null || linkQuery.isError);
  useEffect(() => {
    if (linkGone)
      void navigate({
        to: SIGN_IN_PAGE as string,
        search: { error: "needs_code", next } as never,
        replace: true,
      });
  }, [linkGone, navigate, next]);
  const domain = google?.domains[0];
  const googleHref = google ? startHref(google.start, next) : undefined;
  // Design (#2590): 12px between the heading and a notice under it.
  const banner = error ? (
    <div className="mt-3">
      <Notice tone="danger">{errorCopy(error, name, domain, via)}</Notice>
    </div>
  ) : (
    deadLink && (
      <div className="mt-3">
        <Notice tone="info">{DEAD_LINK}</Notice>
      </div>
    )
  );
  const secondary = Boolean(google || email);
  const accessButton = access && (
    <Button
      asChild
      variant={secondary ? "outline" : "default"}
      className="oa-split-btn"
      style={secondary ? { marginTop: 12 } : undefined}
    >
      <a href={startHref(access.start, next)}>
        <KeyIcon />
        Continue with Cloudflare Access
      </a>
    </Button>
  );

  // Access only: one button.
  if (!google && !email && accessButton)
    return (
      <>
        <h1>Log in to {name}</h1>
        {banner}
        <p className="oa-split-sub">Use your work email to open {name}.</p>
        {accessButton}
      </>
    );

  if (!google && !email)
    return (
      <>
        <h1>Log in to {name}</h1>
        <p className="oa-split-sub">Login isn't set up yet. Ask your admin.</p>
      </>
    );

  // Trial: no Google yet, so codes are the main way in.
  if (!google && email)
    return (
      <>
        <h1>Log in to {name}</h1>
        {banner}
        {step === "email" && (
          <p className="oa-split-sub">We'll email you an 8-digit login code.</p>
        )}
        <CodeSignIn
          next={next}
          turnstileSiteKey={email.turnstileSiteKey}
          onStep={onStep}
        />
        {step === "email" && accessButton}
        {step === "email" && (
          <p className="oa-note">
            {name} is trying Open Artifacts. Codes go to work addresses and
            invited guests. Once your admin connects Google, you'll log in with
            Google instead.
          </p>
        )}
      </>
    );

  const guests = email?.guests ? email : undefined;

  // #2590 G2 (a): Google couldn't confirm the shared address (needs_code,
  // link=1): the masked address the server holds, and a code for it when
  // codes are on; with codes off, only what to ask for.
  // #2590 G2 (a) with codes off: no link, no address (OA Product).
  if (error === "needs_code" && !email)
    return (
      <>
        <h1>Log in to {name}</h1>
        <div className="mt-3">
          <Notice tone="info">{NEEDS_CODE_NO_CODES}</Notice>
        </div>
        {/* Design: a quiet way to try again with Google. */}
        {googleHref && (
          <Button
            asChild
            variant="outline"
            className="oa-split-btn"
            style={{ marginTop: 16 }}
          >
            <a href={googleHref}>Try another account</a>
          </Button>
        )}
      </>
    );

  if (linked)
    return (
      <>
        <h1>Log in to {name}</h1>
        {linked.isPending ? (
          <p aria-busy="true" className="oa-split-sub" />
        ) : linked.data && email ? (
          <>
            {step === "email" && (
              <div className="mt-3 mb-4">
                <Notice tone="info">{needsCode(linked.data)}</Notice>
              </div>
            )}
            <CodeSignIn
              next={next}
              turnstileSiteKey={email.turnstileSiteKey}
              googleHref={googleHref}
              onStep={onStep}
              variant="guest"
              link={{ maskedEmail: linked.data }}
              onStartOver={startOver}
              submitLabel="Email me a code"
            />
          </>
        ) : (
          // Gone or unreadable: on its way to the usual page (above).
          <p aria-busy="true" className="oa-split-sub" />
        )}
      </>
    );

  // #2590 G2 (b): Google said no_access, they used another account. Try
  // another, or get a code at the shared address (no link: an empty field).
  if (error === "no_access" && via === "google" && google && isPageLink(next))
    return (
      <>
        <h1>Log in to {name}</h1>
        {step === "email" && (
          <div className="mt-3 mb-4">
            <Notice tone="info">
              {email ? WRONG_ACCOUNT : WRONG_ACCOUNT_NO_CODES}
            </Notice>
          </div>
        )}
        {codeForm && email ? (
          <CodeSignIn
            next={next}
            turnstileSiteKey={email.turnstileSiteKey}
            googleHref={googleHref}
            onStep={onStep}
            variant="guest"
            submitLabel="Email me a code"
          />
        ) : (
          <>
            <Button asChild className="oa-split-btn">
              <a href={googleHref}>Try another account</a>
            </Button>
            {email && (
              <Button
                variant="outline"
                className="oa-split-btn"
                style={{ marginTop: 12 }}
                onClick={() => setCodeForm(true)}
              >
                Email me a code
              </Button>
            )}
          </>
        )}
      </>
    );

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
        <h1>{step === "email" ? "Get a login code" : `Log in to ${name}`}</h1>
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

  // #3029: a refused Google account on the plain page gets the same
  // "Try another account" action the share-link page has (same Google start).
  const wrongGoogle = error === "no_access" && via === "google";

  // Google only: one button; guests get their own row.
  return (
    <>
      <h1>Log in to {name}</h1>
      {banner}
      <p className="oa-split-sub">
        {domain
          ? `Use your ${domain} Google account.`
          : "Use your Google account."}
      </p>
      <Button asChild className="oa-split-btn">
        <a href={googleHref}>
          {wrongGoogle ? "Try another account" : "Continue with Google"}
        </a>
      </Button>
      {/* #3029: only the plain page, not a share link or a refusal. */}
      {!error && !isPageLink(next) && (
        <p
          data-invited-help=""
          style={{
            margin: "12px 0 0",
            fontSize: 13,
            color: "var(--oa-text-muted)",
          }}
        >
          {INVITED_HELP}
        </p>
      )}
      {accessButton}
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
              Get a login code
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
  via,
  link,
  dead,
}: {
  /** #3029: ?dead=1, the dashboard had no route for the address asked. */
  dead?: boolean;
  error?: string;
  next?: string;
  method?: string;
  via?: "access" | "google";
  /** #2590 G2: ?link=1, the server holds a refused guest's address. */
  link?: boolean;
}) {
  useDocumentTitle("Log in");
  const providers = useAuthProviders();
  const parsed =
    error !== undefined ? SignInErrorSchema.safeParse(error) : null;
  const shownError = parsed ? (parsed.success ? parsed.data : "failed") : null;
  // #3029: the dashboard itself sent an anonymous visitor here from a path it
  // has no route for (?dead=1); server redirects never carry the flag. A
  // `next` wins: dead=1 beside one is not ours, so it is ignored.
  const deadLink = dead === true && !next;
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
  // AuthProviders.hosted says which; an older server's Access mode is
  // self-hosted, as before.
  if (data.mode === "access")
    return (
      <Shell hosted={data.hosted ?? false}>
        <AccessSignIn failed={error !== undefined} />
      </Shell>
    );
  // Direct mode covers hosted and self-hosted installs alike; an older server
  // doesn't say which, so claim neither.
  return (
    <Shell hosted={data.hosted ?? null}>
      <HostedSignIn
        providers={data}
        error={shownError}
        next={safeNext(next)}
        deadLink={deadLink}
        method={method === "code" ? "code" : undefined}
        via={via}
        link={link}
      />
    </Shell>
  );
}
