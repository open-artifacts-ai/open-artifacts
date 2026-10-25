---
title: Privacy Policy
description: What data hosted Open Artifacts and this website collect, why, and how long we keep it.
updated: "[TODO: date of publication]"
---

This policy explains what **[TODO: legal entity name]** ("we", "us") collects when you use:

- **Hosted Open Artifacts**, at open-artifacts.app and its subdomains ("the Service"); and
- **this website**, open-artifacts.com.

**Self-hosted instances aren't covered.** If you run Open Artifacts in your own Cloudflare account, the data stays in that account and you're the one responsible for it. If you use an instance someone else runs, ask its operator; their policy applies.

**Who decides.** On the Service, each organization's workspace (an "instance") belongs to its owner. The owner and admins decide who's a member and what's shared, and we process the instance's content and member data to run the Service for them. **[TODO: confirm controller and processor roles, and whether to offer a data processing agreement, with a lawyer.]**

## What we collect

### Your account

- Your **email address** and **name**, from Google sign-in or from the email you enter for a sign-in code. You can set a separate display name.
- From Google sign-in, your Google account id and your Google Workspace domain. We don't read or keep your profile picture.
- Your **role** (owner, admin, member or guest), your status, and when you joined and were last active.
- For sign-in codes, we keep only a one-way hash of your email and of the code, never the code itself, and codes expire after 10 minutes.

We store no passwords.

### What you and your agents publish

- The **files** of every artifact and every version of it, uploads, and thumbnail images of artifacts.
- Each artifact's **title, description and text**, so you can search it. Search covers only artifacts you can open.
- Who published each version, and the name of the AI agent that published it.
- **Sharing**: the email addresses you share with, and their roles.
- **Live data** that viewers write in live pages, with the writer's account id, or an anonymous id for viewers who aren't signed in. We don't store their IP address with it.

### Connected AI agents and tokens

When you connect an AI agent, we keep:

- the name it registered with, and the version it reports;
- whether it runs on a computer or as a hosted service, and that service's host name;
- the browser family and operating system family you approved it from (for example "Chrome on macOS");
- when it was last used, how many versions it published, and any label you give it.

We don't keep your IP address or full browser details for this. For personal access tokens we keep a label and a one-way hash, never the token itself.

### Activity records

- An **audit log** of changes to the instance: who did what (for example, changed a role or a space), recorded with account ids.
- **Service logs** for running and fixing the Service. They contain ids and event types. We remove email addresses, links and tokens from error messages, and we don't log IP addresses.
- To limit abuse, we count sign-in code requests per email and per network. These counters use one-way hashes, and they're deleted after a day.

### Cookies and browser storage

The Service uses only cookies it needs to work. All are `HttpOnly`, `Secure` and `SameSite=Lax`:

| Cookie | What it's for | How long |
|---|---|---|
| `__Host-oa_session` | Keeps you signed in | 7 days (1 day for guests) |
| `__Host-oa_oidc_…` | Protects a Google sign-in in progress | 15 minutes |
| `__Host-oa_code` | Protects a sign-in code in progress | 10 minutes |
| `__Host-oa_dir` | Protects a Google directory connection in progress | 10 minutes |

The Service also keeps a few things in your browser's local storage: an anonymous id, so live pages can tell your edits apart if you aren't signed in, and display preferences such as the theme. Artifacts are served from a separate host that sets no cookies.

**This website** (open-artifacts.com) sets no cookies and runs no analytics script. **[TODO: confirm Cloudflare Web Analytics is off for the open-artifacts.com zone, or disclose it here.]**

## Google user data

This section describes how we use data from Google APIs.

**Open Artifacts' use and transfer of information received from Google APIs to any other app will adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.**

### Sign in with Google

- **What we ask for:** the `openid`, `email` and `profile` scopes.
- **What we use:** your Google account id, your email address (only if Google has verified it), your name, and your Google Workspace domain.
- **Why:** to sign you in, to check that you belong to the organization's domain, and to show your name to people you work with.
- **How it's stored:** in the instance's database on Cloudflare, described below. We use Google's ID token once, to sign you in, and don't keep it. We don't keep any Google access token or refresh token for sign-in.

### Google Workspace directory (only if your organization connects it)

An admin who is a **Google Workspace super admin** can connect the organization's directory, so membership follows Google. Nothing is read from the directory before they connect it and confirm.

- **What we ask for:** read-only access, through these scopes:
  - `admin.directory.user.readonly`: each user's id, primary email, whether they're suspended or an admin, and the organization's customer id;
  - `admin.directory.group.readonly`: groups' ids, emails, names and member counts, and each group's members (id, email and type);
  - `admin.directory.domain.readonly`: used once, when the directory is connected, to confirm the connecting admin's domain is a verified domain of their Google organization. Nothing from it is stored;
  - `admin.reports.audit.readonly`: to notice user and group changes within minutes, such as someone suspended or added to a group. Nothing from it is stored;
  - plus `openid` and `email`, to confirm who connected it.
- **Why:** to add and remove members, keep their access in step with Google groups, and remove access when someone leaves.
- **What we store:** which Google user each member is, their status, group ids and emails, group memberships, the customer id and domain, and who connected the directory and when.
- **How often:** we check for changes every 2 minutes and do a full check every hour.
- **The refresh token:** encrypted (AES-GCM) with a key only that instance holds, and stored in the instance's database.
- **We never change anything in Google.** Every scope is read-only.
- **Disconnecting:** the owner can choose **Disconnect directory** in Settings, Directory, while signed in themselves (not through a token or an AI agent). That revokes our access at Google and deletes the stored token, and we email the owner to confirm. Members stay, and are managed in Open Artifacts from then on. Deleting the instance also revokes our access at Google. You can also remove Open Artifacts at any time in your Google Admin console, under Security, API controls. **[TODO: confirm "Disconnect directory" and revoke on instance delete are built before publishing.]**

### What we never do with Google data

We don't sell Google user data. We don't use it for advertising, and we don't use it to develop, improve or train AI or machine learning models. We don't transfer it to anyone except as needed to run the Service (to the providers listed below), to comply with the law, or with your organization's permission. People at **[TODO: entity name]** don't read it, except with your permission, for security or abuse investigations, or when the law requires.

## How we use your data

We use data only to:

- run the Service: sign you in, store, show, share and search your artifacts, and run live pages;
- send the emails the Service needs: sign-in codes, invitations, share notices, and directory alerts. An invitation or share email includes the sender's name and the artifact's title, and replies go to the sender;
- keep the Service secure: limit abuse, investigate problems, and keep the audit log;
- comply with the law.

We don't sell your data, show ads, or use your content to train AI models. **The Service doesn't send your content to any AI model.**

**AI agents you connect.** A connected agent acts as you, and can read what your account can read. What it reads goes to that agent and its model provider, under their terms and privacy policy, not ours.

## Where it's stored, and who processes it

Everything is stored with **Cloudflare**, on its global network: the database (D1), files (R2), key-value storage (KV) and live data (Durable Objects). Each instance has its own database and storage. We don't choose a region; Cloudflare places the data.

The providers that process data for us:

| Provider | What for |
|---|---|
| Cloudflare | Hosting and storage; service logs; sending email; Turnstile, a bot check on sign-in code requests, which receives your IP address; and Browser Run, which renders artifacts in a remote browser to make thumbnails |
| Google | Sign-in, and the Google Workspace directory if your organization connects it |
| GitHub | Checking for new Open Artifacts releases; no personal data is sent |

Fonts are served by us, not by a third party. **[TODO: add the entity's own processors, for example billing, once they exist.]**

## How long we keep it

| Data | How long |
|---|---|
| Artifacts and their versions | Until you delete the artifact. Every version is kept while it exists. |
| Deleted artifacts | 30 days in trash, then deleted for good, with their files, thumbnails, live data and search text |
| Unused uploads | 24 hours |
| Sign-in codes | 10 minutes |
| Sign-in abuse counters | 1 day |
| Sessions | 7 days, or until you sign out or are removed |
| A pending Google directory connection | 24 hours |
| Audit log | 400 days, then deleted by a daily job |
| Service logs | **[TODO: confirm Cloudflare Workers Logs retention for our plan and state it.]** |
| Database backups | Cloudflare keeps a 30-day restore window for the database, so deleted database records can be restored for up to 30 days. Files and live data aren't backed up. |
| The owner's email after an instance is deleted | 30 days **[TODO: confirm the purge is built before publishing.]** |

## Removing people, and deleting an instance

- **When someone is removed** from an instance, by an admin or because they left the Google directory, their access ends at once, their tokens and agents are revoked, and they're signed out. Their name stays on work they published, so others can see who made it. If they were removed because they left the Google directory, their email is replaced with a placeholder. **[TODO: this depends on whether hosted instances run with spaces on (Manager ruling pending). With spaces off, a removed member's record is deleted and their artifacts and versions move to the owner. Also confirm what happens to their past live-data edits.]**
- **When an owner deletes an instance**, we delete its artifacts, files, members, settings and database, and revoke our access to its Google directory. We keep the owner's email and the instance's address for 30 days, then delete them or replace them with a one-way hash.

## Your choices and rights

- You can see and change your name in your profile, and delete your artifacts at any time.
- Your organization's owner and admins can remove members and revoke agents and tokens. The owner can also disconnect the directory and delete the instance.
- To get a copy of your data, correct it, or delete your account, email **[TODO: privacy contact email]**. If your account belongs to an organization, we may need to involve its owner. We reply within **[TODO: for example 30 days]**. **[TODO: list the rights that apply where you operate (for example GDPR and UK GDPR, or CCPA), and how to complain to a regulator.]**
- You can revoke Open Artifacts' access to your Google account at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Children

The Service isn't meant for children under **[TODO: 13 or 16, depending on where you operate]**, and we don't knowingly collect their data.

## Security

Artifacts run in a sandbox on a separate host, so they can't read your session or the dashboard. Sign-in sessions are signed and expire, tokens and codes are stored only as hashes, and the Google directory token is encrypted. Our [security model](/docs/security/) has the details.

## Changes

If we change this policy in a way that matters, we'll tell instance owners by email or in the app before it takes effect. The date at the top shows the latest version.

## Contact

**[TODO: privacy contact email and postal address]**
