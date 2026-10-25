---
title: Security model
description: How Open Artifacts isolates untrusted artifacts and decides who sees what.
order: 5
---

Agents write the code in your artifacts, so Open Artifacts treats every artifact as untrusted. An artifact must never be able to read a viewer's session, call the API as the viewer, or reach the dashboard.

## Two hosts

Each instance uses two hostnames:

- **The app host** serves the dashboard, `/mcp`, `/api/`, and the viewer shell at `/a/{id}`.
- **The content host** serves only raw artifact files. It never sets cookies.

## The sandbox

The viewer shell loads each artifact from the content host in an iframe with `sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"`. It never adds `allow-same-origin` or `allow-top-navigation`, so every artifact runs in an opaque origin: it can't read cookies, the dashboard, or other artifacts.

Every content-host response also sends `Content-Security-Policy: sandbox` with the same flags, so opening a content URL directly is just as isolated.

Private content URLs carry a signed token that expires after {LIMIT_SIGNED_URL_TTL}, because the content host has no session. Public artifacts need no token. Revoking a share, unsharing, or deleting an artifact refuses new content URLs immediately, but a URL that was already issued keeps working until it expires, up to {LIMIT_SIGNED_URL_TTL} later.

## Live pages without credentials

The [runtime API](/docs/runtime-api/) talks to the shell over `postMessage`. The shell checks each call against the artifact's declared capabilities and makes it with the viewer's session. The artifact itself never holds a credential.

## Sign-in

Cloudflare Access is the identity provider, using a one-time PIN by email, or GitHub or Google if you turn them on. Open Artifacts stores no passwords. After sign-in, the Worker issues its own `HttpOnly`, `Secure`, `SameSite=Lax` session cookie that lasts 7 days. Requests that change data with that cookie must also send the header `X-OA-Request: 1`.

## Who can see what

| Visibility | Who can open it |
|---|---|
| `private` (default) | The creator and the people it's shared with |
| `team` | Every member of the instance |
| `public` | Anyone with the link, without signing in |

- **Roles:** the owner and admins manage members and settings. Members publish. Guests see only what's shared with them.
- **Shares** give a person `viewer` or `editor` access by email. Editors can publish new versions, edit the title and description, and restore versions.
- **Only the creator** can share an artifact, change its visibility, or delete it. Admins can't see other people's private artifacts.
- **No access looks like no artifact.** Anything you can't see returns `404`, never `403`.

## Tokens

Personal access tokens look like `oa_pat_` followed by 32 characters. Only a SHA-256 hash is stored. Tokens belong to one user and can be revoked from **Settings → Agents**.

## Audit log

Admin actions, such as changes to members, roles, spaces and the Google directory, are recorded in an audit log. The owner and admins can read and export it. Each event records who did what using account ids, and emails are looked up only when the log is read.

Events are kept for 400 days. A daily job then deletes older ones; a large backlog can take a few extra days to clear.

## Never indexed

Public links are for sharing, not search. Both hosts send `X-Robots-Tag: noindex, nofollow` on every response, and their `robots.txt` disallows everything. Only public artifacts get their real title in link previews; private links show a generic title.

## No telemetry

A deployed instance sends nothing to the Open Artifacts project or anyone else.

## Fonts

The dashboard and the Markdown renderer load the Geist fonts from Google Fonts, on both hosts. Each viewer's browser fetches them from `fonts.googleapis.com` and `fonts.gstatic.com`, so Google sees the viewer's IP address. To avoid this, block those two hosts in your network or browser; pages then fall back to system fonts and work the same.
