// The one welcome email of a signup: plain text, the install's app host and
// nothing else (no token, no link with a secret). The owner signs in on the
// install's own sign-in page.

export interface Welcome {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export function welcomeEmail(o: {
  from: string;
  to: string;
  appHost: string;
}): Welcome {
  return {
    from: o.from,
    to: o.to,
    subject: "Your Open Artifacts workspace is ready",
    text: [
      "Your Open Artifacts workspace is ready at:",
      "",
      `  https://${o.appHost}`,
      "",
      "Sign in there with the account you signed up with.",
      "",
      "You received this because you signed up for Open Artifacts.",
    ].join("\n"),
  };
}
