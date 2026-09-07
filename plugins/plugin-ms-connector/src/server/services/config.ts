import type { Application } from '@nocobase/server';

// Must stay in sync with the API permissions registered on the Azure AD app
// registration (App registrations → API permissions → Microsoft Graph →
// Delegated). Requesting a scope that is not consented fails the consent
// flow; registering one that is never requested is an over-broad grant. Each
// entry below maps to a shipped AI tool:
//
//   Mail.Read              → msMailListEmails, msMailGetEmail
//   Mail.Send               → msMailSendEmail
//   Calendars.ReadWrite     → msCalendar{ListCalendars,ListEvents,CreateEvent,
//                             UpdateEvent,DeleteEvent,ListSharedEvents}
//
// Adding a tool that needs broader authority means adding the permission in
// the Azure app registration first, and updating README.md.
export const DEFAULT_SCOPES = [
  'openid',
  'email',
  'profile',
  'offline_access',
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/Calendars.ReadWrite',
];

export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export function authorizeUrl(tenant: string): string {
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`;
}

export function tokenUrl(tenant: string): string {
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
}

export interface MsClientCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tenant: string;
}

export async function resolveMsCredentials(app: Application): Promise<MsClientCredentials> {
  const vars = readEnv(app);

  const clientId = vars['ms_client_id'] || vars['MS_CLIENT_ID'] || process.env.MS_CLIENT_ID;

  const clientSecret =
    vars['ms_client_secret'] || vars['MS_CLIENT_SECRET'] || process.env.MS_CLIENT_SECRET;

  const redirectUri =
    vars['ms_redirect_uri'] || vars['MS_REDIRECT_URI'] || process.env.MS_REDIRECT_URI;

  // "common" accepts both personal Microsoft accounts and work/school
  // accounts from any Azure AD tenant — the right default for a general
  // connector. Set ms_tenant_id to restrict to a single tenant.
  const tenant =
    vars['ms_tenant_id'] || vars['MS_TENANT_ID'] || process.env.MS_TENANT_ID || 'common';

  if (!clientId || !clientSecret) {
    throw new Error(
      'Microsoft OAuth credentials not configured. Define Variable `ms_client_id` and Secret `ms_client_secret` in NocoBase → Settings → Variables and secrets (or set MS_CLIENT_ID / MS_CLIENT_SECRET env vars).',
    );
  }

  if (!redirectUri) {
    throw new Error(
      'Microsoft OAuth redirect URI not configured. Define Variable `ms_redirect_uri` in NocoBase → Settings → Variables and secrets (e.g. `https://your-nocobase.example.com/api/msConnections:callback`), or set MS_REDIRECT_URI. The value must match a Redirect URI registered on your Azure AD app registration.',
    );
  }

  return { clientId, clientSecret, redirectUri, tenant };
}

function readEnv(app: Application): Record<string, string> {
  const env: any = (app as any).environment;
  if (env && typeof env.getVariables === 'function') return env.getVariables() || {};
  return {};
}
