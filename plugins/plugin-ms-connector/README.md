# @deepcraft/plugin-ms-connector

[![License: MIT](https://img.shields.io/badge/license-MIT-22D3EE?style=flat-square)](https://opensource.org/licenses/MIT)

Connect your **NocoBase** app (and its **AI employees**) to **Outlook Mail** and
**Microsoft Calendar** (Microsoft Graph) via user-consented OAuth.

The plugin ships:

- A **"Connect Microsoft" block** you can drop on any page — one-click OAuth in a popup, shows the connected account and lets the user reconnect / disconnect.
- A **public OAuth callback endpoint** that Microsoft can hit directly (no NocoBase login required for the redirect itself).
- **Automatic token rotation** — access tokens are refreshed transparently before every Mail/Calendar call using the stored refresh token, so AI agents can keep acting on the user's behalf without re-prompting for consent.
- **REST endpoints** for the operations any HTTP client can call: list/get/send emails, list/create/update/delete events, list events on other calendars.
- **AI-plugin tool registration** — if the NocoBase AI plugin is enabled, the same operations are automatically exposed as tools any AI employee can call.
- Credentials come from NocoBase **Variables and Secrets** (not from files), so you can rotate them centrally.

## Contents

- [Install](#install)
- [Configure — Azure AD app registration](#configure--azure-ad-app-registration)
- [Configure — NocoBase Variables and Secrets](#configure--nocobase-variables-and-secrets)
- [Use the block](#use-the-block)
- [Use with AI employees](#use-with-ai-employees)
- [REST endpoints](#rest-endpoints)
- [Token rotation & lifecycle](#token-rotation--lifecycle)
- [Uninstall / privacy](#uninstall--privacy)
- [Build](#build)

## Install

1. Grab a release `.tgz` (or build it yourself — see [Build](#build)).
2. Copy the `.tgz` to your NocoBase app's `./storage/plugins/` directory.
3. In NocoBase go to **Plugin Manager** (URL: `/v/admin/`), find **Microsoft Connector** and **Enable** it.

> **NocoBase compatibility:** `>=1.6.0` (modern client-v2). This plugin does **not** register anything under the legacy `/admin/...` plugin manager.

## Configure — Azure AD app registration

You'll need an Azure AD (Microsoft Entra ID) app registration with Microsoft
Graph delegated permissions. Handy shortcuts:

- Microsoft Entra admin center: <https://entra.microsoft.com/>
- App registrations: <https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade>
- New registration: <https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade>

Then:

1. **App registrations → New registration.**
   - **Name:** anything recognizable, e.g. "NocoBase Microsoft Connector".
   - **Supported account types:** choose **"Any Entra ID Tenant + Personal Microsoft Accounts"** (Microsoft's current label for "Accounts in any organizational directory (Any Microsoft Entra ID tenant – Multitenant) and personal Microsoft accounts, e.g. Skype, Xbox") for the broadest reach — it maps to the `common` OAuth endpoint, which is what `ms_tenant_id` defaults to below. Restrict to your own tenant instead if you don't need personal/other-org accounts.
   - **Redirect URI:** platform **Web**, value:

     ```
     <YOUR_APP_URL>/api/msConnections:callback
     ```

     Examples:
     ```
     http://localhost:13000/api/msConnections:callback           # local dev
     https://nocobase.mycompany.com/api/msConnections:callback   # production behind a domain / reverse proxy
     ```

     > **Important:** whatever URL you register here must **exactly** match the value of the `ms_redirect_uri` variable you'll set in NocoBase next. If they differ, Microsoft returns `redirect_uri_mismatch`.

2. **Certificates & secrets → New client secret.** Copy the secret **value** immediately — it's only shown once. This is `ms_client_secret` below.

3. **Overview** page: copy the **Application (client) ID** — this is `ms_client_id`. If you restricted supported account types to a single tenant, also copy the **Directory (tenant) ID** — this is `ms_tenant_id`.

4. **API permissions → Add a permission → Microsoft Graph → Delegated permissions**, add exactly these — no more:

   | Permission | Microsoft classification | Grants | Used by |
   | --- | --- | --- | --- |
   | `openid`, `email`, `profile`, `offline_access` | Basic | Identify the connected account + issue a refresh token | Connection record (`msEmail`), token rotation |
   | `Mail.Read` | Sensitive | Read the user's mail | `msMailListEmails`, `msMailGetEmail` |
   | `Mail.Send` | Sensitive | Send mail as the user | `msMailSendEmail` |
   | `Calendars.ReadWrite` | Sensitive | Read and write the user's calendars | `msCalendarListCalendars`, `ListEvents`, `CreateEvent`, `UpdateEvent`, `DeleteEvent`, `ListSharedEvents` |

   This set is the **minimum** for the tools the plugin ships, and it must match
   [`DEFAULT_SCOPES`](src/server/services/config.ts) exactly. Two failure modes if it drifts:

   - **Scope requested but not granted in the app registration** → the consent flow fails, or Microsoft silently withholds it and every Graph call 403s.
   - **Scope granted but never requested** → an over-broad grant with nothing to justify it.

   > **On `Mail.ReadWrite` / `Mail.Send`:** the plugin deliberately requests `Mail.Read` (not `Mail.ReadWrite`) plus `Mail.Send`. It never labels, moves, marks read, or deletes messages — `Read` + `Send` covers every shipped tool.

   > If your tenant requires **admin consent** for these permissions, click **Grant admin consent** on this page, or each user will be blocked at the consent screen.

5. Click **Add a permission** is enough for delegated, user-consented scopes — no client-credentials / application-permission setup is needed; this plugin always acts as the signed-in user, never as a background service account.

## Configure — NocoBase Variables and Secrets

Requires the built-in **Variables and Secrets** plugin (enabled by default in recent NocoBase releases). Go to **Settings → Variables and secrets** and add:

| Name                | Kind     | Value                                                  |
| -------------------- | -------- | ------------------------------------------------------ |
| `ms_client_id`       | Variable | The Application (client) ID from the app registration. |
| `ms_client_secret`   | Secret   | The client secret **value** from the app registration. |
| `ms_redirect_uri`    | Variable | Full callback URL, e.g. `https://nocobase.mycompany.com/api/msConnections:callback`. Must **exactly** match the Redirect URI on the app registration. |
| `ms_tenant_id`       | Variable | *(optional)* Directory (tenant) ID, or a domain like `contoso.onmicrosoft.com`. Defaults to `common` (personal + any organizational account). |

> **`ms_tenant_id` must match what "Supported account types" was actually set to on the app registration** — it's not independently configurable:
>
> - Registration set to **"Any Entra ID Tenant + Personal Microsoft Accounts"**: leave `ms_tenant_id` **unset** (or delete it if you'd previously set one). The plugin defaults to `common`, which is the only tenant value that endpoint accepts.
> - Registration set to **single tenant** ("Accounts in this organizational directory only"): set `ms_tenant_id` to that **Directory (tenant) ID**, copied from the app registration's Overview page. Leaving it as `common` here — or leaving a leftover tenant GUID in place after widening the registration to multi-tenant — causes Microsoft to reject the request or wrongly restrict who can connect.
>
> In short: the value here should always mirror the account-type choice on the app registration, not be picked independently.

If you can't or don't want to use Variables & Secrets, the plugin falls back to environment variables of the same names in upper case:

- `MS_CLIENT_ID`
- `MS_CLIENT_SECRET`
- `MS_REDIRECT_URI`
- `MS_TENANT_ID` *(optional)*

**Verify configuration** at any time:

```
POST /api/msTools:configStatus
```

Returns `{ configured: true, redirectUri, tenant, clientIdSuffix }` when the plugin can resolve credentials.

## Use the block

1. Open any Modern-UI page (`/v/...`).
2. **Add block** → **Others** → **Connect Microsoft**.
3. Click **Connect** in the block. A popup opens the Microsoft sign-in/consent screen; on success the popup closes automatically and the block flips to **Connected as `<your email>`**.
4. **Disconnect** removes the stored tokens from `msConnections`. Microsoft Graph has no per-app token-revoke endpoint, so this does not sign the user out elsewhere — see [Token rotation & lifecycle](#token-rotation--lifecycle).

The block appears in **Settings → Connect Microsoft**.

## Use with AI employees

If the [NocoBase AI plugin](https://docs.nocobase.com/handbook/ai) is enabled, this plugin registers these tools with `aiManager.toolsManager` on load:

| Tool name                       | Purpose                                                        |
| -------------------------------- | --------------------------------------------------------------- |
| `msMailListEmails`               | List emails (free-text search, folder, `maxResults` up to 50). |
| `msMailGetEmail`                 | Read one email (text + HTML body).                              |
| `msMailSendEmail`                | Send an email on the connected user's behalf.                   |
| `msCalendarListCalendars`        | List every calendar in the user's own calendar list.             |
| `msCalendarListEvents`           | List events on a specific calendar (default: primary) in a time range. |
| `msCalendarCreateEvent`          | Create an event (optionally invite attendees).                  |
| `msCalendarUpdateEvent`          | Partial-update an existing event (reschedule / edit).            |
| `msCalendarDeleteEvent`          | Cancel / delete an event.                                        |
| `msCalendarListSharedEvents`     | List events across every non-primary calendar in the user's list. |

Bind them to an AI employee in **Settings → AI → Employees → Tools**. Tools run in the caller's user context, so each employee acts on behalf of the user who is chatting with it — no shared service account.

> **Summarization** is intentionally not a separate tool. The employee should call `msMailGetEmail` and summarize the returned body itself — that leaves the whole email visible in the conversation and doesn't hard-code a summarization prompt.
>
> **On "shared" calendars:** Microsoft Graph has no implicit "shared with me" calendar set the way Google Calendar does — `/me/calendars` only returns calendars the user owns or has explicitly added to their own calendar list. `msCalendarListSharedEvents` reflects that: it aggregates every non-primary calendar already in the user's list, not every calendar shared with them tenant-wide.

The [REST endpoints](#rest-endpoints) below document every call shape, and are what to paste worked examples of into an employee's prompt.

## REST endpoints

Even without the AI plugin, everything is callable over HTTP. All endpoints are `POST` unless noted; auth = logged-in NocoBase user; body = JSON `{ "values": {...} }`.

| Endpoint                            | Body / query                                    | Returns                          |
| ------------------------------------ | ----------------------------------------------- | --------------------------------- |
| `POST /api/msConnections:authorize`  | —                                               | `{ authorizeUrl, redirectUri }`   |
| `GET  /api/msConnections:callback`   | `?code&state` (called by Microsoft, **public**) | HTML page + `postMessage` to opener |
| `GET  /api/msConnections:status`     | —                                               | `{ connected, msEmail, scopes, expiresAt, status }` |
| `POST /api/msConnections:disconnect` | —                                               | `{ connected: false }`            |
| `POST /api/msTools:configStatus`     | —                                               | `{ configured, redirectUri, tenant, clientIdSuffix }` |
| `POST /api/msTools:listEmails`       | `{ values: { query?, maxResults?, folder? } }`  | Array of email summaries          |
| `POST /api/msTools:getEmail`         | `{ values: { id } }`                             | Email detail + bodies             |
| `POST /api/msTools:sendEmail`        | `{ values: { to, subject, body, cc?, bcc?, isHtml? } }` | `{ sent: true }`          |
| `POST /api/msTools:listCalendars`    | —                                                | Array of calendars                |
| `POST /api/msTools:listEvents`       | `{ values: { calendarId?, timeMin?, timeMax?, q?, maxResults? } }` | Array of events |
| `POST /api/msTools:createEvent`      | `{ values: { summary, start, end, description?, location?, attendees?, calendarId? } }` | Event |
| `POST /api/msTools:updateEvent`      | `{ values: { eventId, ...fields to change } }`   | Event                              |
| `POST /api/msTools:deleteEvent`      | `{ values: { eventId, calendarId? } }`           | `{ deleted: true, eventId, calendarId }` |
| `POST /api/msTools:listSharedEvents` | `{ values: { timeMin?, timeMax?, q?, maxResults? } }` | Events on non-primary calendars |

## Token rotation & lifecycle

- **Refresh tokens** are requested with the `offline_access` scope, and stored in the `msConnections.refreshToken` column, AES-256-GCM encrypted at rest by the plugin (keyed from `APP_KEY`/`NOCOBASE_APP_KEY`).
- Every Mail/Calendar call goes through `ensureFreshAccessToken(userId)` — if the current access token expires within 60 seconds it is refreshed against `login.microsoftonline.com/{tenant}/oauth2/v2.0/token` first, and the new token is persisted.
- Unlike Google, **Microsoft rotates the refresh token on every use** — the plugin always persists the new one when the refresh response includes it.
- Microsoft Graph has **no per-app token-revoke endpoint**. The only account-wide alternative (`revokeSignInSessions`) signs the user out of every app and device, not just this connector, so **disconnect only deletes the locally stored tokens** — it does not reach out to Microsoft. If the user wants to fully revoke access, they should remove the app from <https://myaccount.microsoft.com/organizations> (work/school) or <https://account.live.com/consent/Manage> (personal).
- If Microsoft ever rejects the stored refresh token (e.g. the user revoked access from their Microsoft account), the row is marked `status=error` and the block prompts the user to reconnect.

## Uninstall / privacy

**By default, tokens are erased when the plugin is disabled or uninstalled.** Concretely:

- `afterDisable()` — deletes every row in `msConnections`.
- `remove()` — same, then the collection's table is dropped by NocoBase.

If you'd like tokens to survive a disable/re-enable cycle, comment out `afterDisable()` in `src/server/plugin.ts` and rebuild.

## Build

Produces a `.tgz` you can drop into any NocoBase instance's `./storage/plugins/`.

```bash
just build-plugin plugin-ms-connector
# → dist/deepcraft-plugin-ms-connector-<version>.tgz
```

`plugins/build.sh`, shared by every plugin here, does the work:

1. Downloads a pinned NocoBase source tree into `./app` on first run, so the
   plugin compiles against the runtime it will be installed into.
2. Rsyncs these sources into that workspace and runs the NocoBase build.
3. Packs the result into `./dist/`.

CI: `.github/workflows/plugin-release.yml` runs the same recipe on every push to
`main` that touches this directory, and replaces the GitHub release named by the
`version` in `package.json`.

## License

MIT
