import type { Application } from '@nocobase/server';
import { z } from 'zod';
import * as mail from './services/mail';
import * as calendar from './services/calendar';

/**
 * Register plugin-ms-connector's Microsoft functions as AI-callable tools.
 *
 * Shape follows the runtime contract used by NocoBase's own `docs.js` and
 * `workflow-caller.js` (not the misleading `tool-manager.d.ts`):
 *
 *   {
 *     scope: 'GENERAL' | 'SPECIFIED' | 'CUSTOM',
 *     from: 'loader' | 'workflow',
 *     defaultPermission?: 'ALLOW' | 'DENY',
 *     introduction: { title, about },
 *     definition: { name, description, schema (zod) },
 *     invoke: async (ctx, args) => ({ status, content }),
 *   }
 *
 * The UI listBinding filter (aiTools.js:73) shows only:
 *   tool.scope === 'GENERAL' && tool.from === 'loader'
 * under "General tools" — so we set both.
 *
 * Per-user isolation: `invoke` receives a NocoBase ctx bound to whoever is chatting
 * with the AI employee. We resolve the userId from ctx.state.currentUser and pass it
 * to the mail/calendar services, which key every token lookup by userId
 * (msConnections.userId is UNIQUE). User A's employee only ever sees User A's
 * Microsoft account.
 */
export function registerAITools(app: Application): void {
  const aiPlugin: any = safeGet(app, 'ai');
  const toolsManager: any =
    aiPlugin?.aiManager?.toolsManager ||
    aiPlugin?.ai?.toolsManager ||
    (app as any).aiManager?.toolsManager;
  if (!toolsManager || typeof toolsManager.registerTools !== 'function') {
    app.logger?.info?.('[ms-connector] plugin-ai not detected; skipping AI tool registration. REST endpoints remain available.');
    return;
  }

  const requireUser = (ctx: any): number => {
    const userId = ctx?.state?.currentUser?.id ?? ctx?.auth?.user?.id ?? ctx?.user?.id;
    if (!userId) throw new Error('AI tool must run in a user-authenticated context.');
    return Number(userId);
  };

  const success = (data: unknown) => ({ status: 'success' as const, content: JSON.stringify(data) });
  const failure = (err: unknown) => ({
    status: 'error' as const,
    content: err instanceof Error ? err.message : String(err),
  });

  const make = (
    name: string,
    title: string,
    about: string,
    description: string,
    schema: z.ZodObject<any>,
    run: (userId: number, args: any) => Promise<unknown>,
  ) => ({
    scope: 'GENERAL' as const,
    from: 'loader' as const,
    defaultPermission: 'ALLOW' as const,
    introduction: {
      title,
      about,
    },
    definition: {
      name,
      description,
      schema,
    },
    invoke: async (ctx: any, args: any) => {
      try {
        return success(await run(requireUser(ctx), args || {}));
      } catch (e) {
        return failure(e);
      }
    },
  });

  const tools = [
    make(
      'msMailListEmails',
      'Outlook Mail — list emails',
      'List recent emails for the current user, optionally filtered by folder and search text.',
      'List recent emails for the current user. Supports a free-text search query and maxResults; defaults to the inbox folder.',
      z.object({
        query: z.string().optional().describe('Free-text search across subject/sender/body.'),
        maxResults: z.number().int().min(1).max(50).optional().default(10),
        folder: z.string().optional().describe('Mail folder id or well-known name, e.g. "inbox" (default), "sentitems".'),
      }),
      (userId, args) => mail.listEmails(app, userId, args),
    ),
    make(
      'msMailGetEmail',
      'Outlook Mail — get email',
      'Fetch a single email by id including its text/HTML body.',
      'Fetch a single email by id including headers, text body, and HTML body. Use this to read or summarize an email.',
      z.object({ id: z.string().describe('Outlook message id.') }),
      (userId, args) => mail.getEmail(app, userId, String(args.id)),
    ),
    make(
      'msMailSendEmail',
      'Outlook Mail — send email',
      "Send an email on the current user's behalf.",
      "Send an email on behalf of the connected user. `to/cc/bcc` accept a single email string or an array.",
      z.object({
        to: z.union([z.string(), z.array(z.string())]),
        cc: z.union([z.string(), z.array(z.string())]).optional(),
        bcc: z.union([z.string(), z.array(z.string())]).optional(),
        subject: z.string(),
        body: z.string(),
        isHtml: z.boolean().optional().default(false),
      }),
      (userId, args) => mail.sendEmail(app, userId, args),
    ),
    make(
      'msCalendarListCalendars',
      'Calendar — list calendars',
      'List every calendar the user owns or has added to their calendar list.',
      "List every calendar the user owns or has added to their own calendar list. Use this before listEvents/createEvent when the user refers to a calendar by name.",
      z.object({}),
      (userId) => calendar.listCalendars(app, userId),
    ),
    make(
      'msCalendarListEvents',
      'Calendar — list events',
      'List events on a specific calendar (defaults to primary) within a time range.',
      "List events on a specific calendar (defaults to the user's primary calendar) within a time range.",
      z.object({
        calendarId: z.string().optional().describe('Calendar id; defaults to the primary calendar.'),
        timeMin: z.string().optional().describe('ISO 8601, defaults to now.'),
        timeMax: z.string().optional().describe('ISO 8601, defaults to 30 days from now.'),
        q: z.string().optional().describe('Free-text search across event fields.'),
        maxResults: z.number().int().min(1).max(100).optional().default(25),
      }),
      (userId, args) => calendar.listEvents(app, userId, args),
    ),
    make(
      'msCalendarCreateEvent',
      'Calendar — create event',
      'Create a new calendar event; can include attendees to invite.',
      "Create a new event on the user's calendar. Set `attendees` to invite people.",
      z.object({
        calendarId: z.string().optional(),
        summary: z.string(),
        description: z.string().optional(),
        location: z.string().optional(),
        start: z
          .object({ dateTime: z.string().optional(), date: z.string().optional(), timeZone: z.string().optional() })
          .describe('Use { dateTime, timeZone } for timed events or { date } for all-day.'),
        end: z.object({ dateTime: z.string().optional(), date: z.string().optional(), timeZone: z.string().optional() }),
        attendees: z.array(z.object({ email: z.string(), optional: z.boolean().optional() })).optional(),
      }),
      (userId, args) => calendar.createEvent(app, userId, args),
    ),
    make(
      'msCalendarUpdateEvent',
      'Calendar — update event',
      'Partial-update an existing event (reschedule, edit fields, change attendees).',
      'Partial-update fields on an existing event. Only the provided fields change. Use this to reschedule, edit summary/description/location, or change attendees.',
      z.object({
        calendarId: z.string().optional(),
        eventId: z.string(),
        summary: z.string().optional(),
        description: z.string().optional(),
        location: z.string().optional(),
        start: z.object({ dateTime: z.string().optional(), date: z.string().optional(), timeZone: z.string().optional() }).optional(),
        end: z.object({ dateTime: z.string().optional(), date: z.string().optional(), timeZone: z.string().optional() }).optional(),
        attendees: z.array(z.object({ email: z.string(), optional: z.boolean().optional() })).optional(),
      }),
      (userId, args) => calendar.updateEvent(app, userId, args),
    ),
    make(
      'msCalendarDeleteEvent',
      'Calendar — delete event',
      'Cancel / delete an event by id.',
      'Cancel / delete an event by id.',
      z.object({
        calendarId: z.string().optional(),
        eventId: z.string(),
      }),
      (userId, args) => calendar.deleteEvent(app, userId, args),
    ),
    make(
      'msCalendarListSharedEvents',
      'Calendar — list events on non-primary calendars',
      "List events across every calendar in the user's calendar list other than their primary calendar.",
      "List events from every calendar in the user's own calendar list other than the primary calendar (Microsoft Graph has no implicit \"shared with me\" set the way Google Calendar does).",
      z.object({
        timeMin: z.string().optional(),
        timeMax: z.string().optional(),
        q: z.string().optional(),
        maxResults: z.number().int().min(1).max(100).optional().default(25),
      }),
      (userId, args) => calendar.listSharedEvents(app, userId, args),
    ),
  ];

  try {
    toolsManager.registerTools(tools);
    app.logger?.info?.(`[ms-connector] Registered ${tools.length} AI tools (scope=GENERAL, from=loader).`);
  } catch (err: any) {
    app.logger?.warn?.(`[ms-connector] Failed to register AI tools: ${err?.message || err}`);
  }
}

function safeGet(app: Application, name: string): any {
  try {
    return app.pm?.get?.(name);
  } catch {
    return undefined;
  }
}
