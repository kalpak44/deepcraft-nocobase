import { Plugin } from '@nocobase/server';
import * as calendar from './services/calendar';
import { resolveMsCredentials } from './services/config';
import * as mail from './services/mail';
import { buildAuthorizeUrl, decodeState, exchangeCodeForToken, fetchUserInfo } from './services/oauth';
import { deleteConnection, getConnection, saveConnection } from './services/tokenStore';
import { registerAITools } from './ai-tools';
import { CALLBACK_HTML } from './callback-page';

function requireUserId(ctx: any): number {
  const userId = ctx?.auth?.user?.id ?? ctx?.state?.currentUser?.id ?? ctx?.state?.user?.id;
  if (!userId) ctx.throw?.(401, 'Not authenticated');
  return Number(userId);
}

export class PluginMsConnectorServer extends Plugin {
  async load() {
    // ------------------------------------------------------------------
    // ACL — permissive for the block/status/disconnect actions, public
    // for the OAuth redirect callback (Microsoft → callback URL, no auth).
    // ------------------------------------------------------------------
    this.app.acl.allow('msConnections', ['authorize', 'status', 'disconnect'], 'loggedIn');
    this.app.acl.allow('msConnections', 'callback', 'public');
    this.app.acl.allow('msTools', '*', 'loggedIn');

    // ------------------------------------------------------------------
    // Connection resource — start/callback/status/disconnect
    // ------------------------------------------------------------------
    this.app.resourceManager.registerActionHandlers({
      'msConnections:authorize': async (ctx, next) => {
        const userId = requireUserId(ctx);
        const { url, redirectUri } = await buildAuthorizeUrl(this.app, userId);
        ctx.body = { authorizeUrl: url, redirectUri };
        await next();
      },

      'msConnections:status': async (ctx, next) => {
        const userId = requireUserId(ctx);
        const conn = await getConnection(this.app, userId);
        ctx.body = conn
          ? {
              connected: conn.status === 'active',
              status: conn.status,
              msEmail: conn.msEmail,
              scopes: conn.scope ? conn.scope.split(/\s+/).filter(Boolean) : [],
              expiresAt: conn.expiresAt,
              lastError: conn.lastError,
            }
          : { connected: false, status: 'not_connected', scopes: [] };
        await next();
      },

      'msConnections:disconnect': async (ctx, next) => {
        const userId = requireUserId(ctx);
        // Microsoft Graph has no per-app token revoke endpoint; the only
        // account-wide option (revokeSignInSessions) would sign the user out
        // everywhere, not just of this app, so disconnect only drops the
        // locally stored tokens.
        await deleteConnection(this.app, userId);
        ctx.body = { connected: false };
        await next();
      },

      // Public: Microsoft redirects the browser here with ?code&state.
      'msConnections:callback': async (ctx, next) => {
        ctx.type = 'html';
        // Skip NocoBase's dataWrapping middleware — the OAuth popup needs
        // raw HTML to run its postMessage + window.close script.
        (ctx as any).withoutDataWrapping = true;
        try {
          const { code, state, error, error_description } = ctx.action.params || (ctx.request as any).query || {};
          if (error) throw new Error(`${error}: ${error_description || ''}`);
          if (!code || !state) throw new Error('Missing code or state');

          const decoded = decodeState(this.app, String(state));
          const token = await exchangeCodeForToken(this.app, String(code));
          if (!token.refresh_token) {
            throw new Error(
              'No refresh_token returned by Microsoft. Make sure the `offline_access` scope is granted and try connecting again.',
            );
          }
          const userInfo = await fetchUserInfo(token.access_token);

          await saveConnection(this.app, decoded.userId, {
            accessToken: token.access_token,
            refreshToken: token.refresh_token,
            expiresAt: new Date(Date.now() + token.expires_in * 1000),
            scope: token.scope,
            tokenType: token.token_type,
            msEmail: userInfo?.mail || userInfo?.userPrincipalName,
            msUserId: userInfo?.id,
            status: 'active',
            lastError: null,
          });

          ctx.body = CALLBACK_HTML({ status: 'success', email: userInfo?.mail || userInfo?.userPrincipalName });
        } catch (err: any) {
          this.app.logger?.warn?.(`[ms-connector] OAuth callback error: ${err?.message || err}`);
          ctx.body = CALLBACK_HTML({ status: 'error', message: err?.message || 'Unknown error' });
        }
        await next();
      },
    });

    // ------------------------------------------------------------------
    // AI-callable REST endpoints — thin wrappers around service helpers
    // so any HTTP client (including external agents) can call them.
    // ------------------------------------------------------------------
    this.app.resourceManager.define({
      name: 'msTools',
      actions: {
        listEmails: async (ctx, next) => {
          const userId = requireUserId(ctx);
          const { values } = ctx.action.params;
          ctx.body = await mail.listEmails(this.app, userId, values || {});
          await next();
        },
        getEmail: async (ctx, next) => {
          const userId = requireUserId(ctx);
          const { values } = ctx.action.params;
          if (!values?.id) ctx.throw(400, 'Missing `id`');
          ctx.body = await mail.getEmail(this.app, userId, values.id);
          await next();
        },
        sendEmail: async (ctx, next) => {
          const userId = requireUserId(ctx);
          const { values } = ctx.action.params;
          if (!values?.to || !values?.subject || !values?.body) ctx.throw(400, 'Missing required fields: to, subject, body');
          ctx.body = await mail.sendEmail(this.app, userId, values);
          await next();
        },
        listCalendars: async (ctx, next) => {
          const userId = requireUserId(ctx);
          ctx.body = await calendar.listCalendars(this.app, userId);
          await next();
        },
        listEvents: async (ctx, next) => {
          const userId = requireUserId(ctx);
          const { values } = ctx.action.params;
          ctx.body = await calendar.listEvents(this.app, userId, values || {});
          await next();
        },
        createEvent: async (ctx, next) => {
          const userId = requireUserId(ctx);
          const { values } = ctx.action.params;
          if (!values?.summary || !values?.start || !values?.end) ctx.throw(400, 'Missing required fields: summary, start, end');
          ctx.body = await calendar.createEvent(this.app, userId, values);
          await next();
        },
        updateEvent: async (ctx, next) => {
          const userId = requireUserId(ctx);
          const { values } = ctx.action.params;
          if (!values?.eventId) ctx.throw(400, 'Missing required field: eventId');
          ctx.body = await calendar.updateEvent(this.app, userId, values);
          await next();
        },
        deleteEvent: async (ctx, next) => {
          const userId = requireUserId(ctx);
          const { values } = ctx.action.params;
          if (!values?.eventId) ctx.throw(400, 'Missing required field: eventId');
          ctx.body = await calendar.deleteEvent(this.app, userId, values);
          await next();
        },
        listSharedEvents: async (ctx, next) => {
          const userId = requireUserId(ctx);
          const { values } = ctx.action.params;
          ctx.body = await calendar.listSharedEvents(this.app, userId, values || {});
          await next();
        },
        configStatus: async (ctx, next) => {
          try {
            const creds = await resolveMsCredentials(this.app);
            ctx.body = { configured: true, redirectUri: creds.redirectUri, tenant: creds.tenant, clientIdSuffix: creds.clientId.slice(-6) };
          } catch (err: any) {
            ctx.body = { configured: false, message: err?.message || String(err) };
          }
          await next();
        },
      },
    });

    // ------------------------------------------------------------------
    // Register AI tools (no-op if plugin-ai is not enabled).
    // ------------------------------------------------------------------
    registerAITools(this.app);
  }

  async afterDisable() {
    // Privacy-conservative: drop stored tokens on disable.
    await this.wipeAllConnections('afterDisable');
  }

  async remove() {
    await this.wipeAllConnections('remove');
  }

  private async wipeAllConnections(reason: string) {
    try {
      const repo = this.app.db.getRepository('msConnections');
      if (!repo) return;
      const count = await repo.count();
      await repo.destroy({ truncate: true } as any).catch(async () => {
        await repo.destroy({ filter: {} });
      });
      this.app.logger?.info?.(`[ms-connector] Cleared ${count} Microsoft connection(s) on ${reason}.`);
    } catch (err: any) {
      this.app.logger?.warn?.(`[ms-connector] Failed to clear connections on ${reason}: ${err?.message || err}`);
    }
  }
}

export default PluginMsConnectorServer;
