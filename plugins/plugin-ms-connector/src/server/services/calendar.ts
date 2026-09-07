import type { Application } from '@nocobase/server';
import { GRAPH_BASE } from './config';
import { ensureFreshAccessToken } from './tokenStore';

async function authFetch(app: Application, userId: number | string, path: string, init: RequestInit = {}) {
  const conn = await ensureFreshAccessToken(app, userId);
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${conn.accessToken}`,
      'Content-Type': 'application/json',
      Prefer: 'outlook.timezone="UTC"',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Microsoft Graph calendar API ${res.status}: ${body}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export interface CalendarEntry {
  id: string;
  summary?: string;
  primary?: boolean;
  accessRole?: string;
  timeZone?: string;
}

export async function listCalendars(app: Application, userId: number | string): Promise<CalendarEntry[]> {
  const res = await authFetch(app, userId, '/me/calendars?$select=id,name,isDefaultCalendar,canEdit,canShare');
  return ((res?.value || []) as any[]).map((c) => ({
    id: c.id,
    summary: c.name,
    primary: !!c.isDefaultCalendar,
    accessRole: c.canEdit ? 'writer' : 'reader',
  }));
}

export interface CalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  htmlLink?: string;
  attendees?: Array<{ email: string; responseStatus?: string; organizer?: boolean; self?: boolean }>;
  organizer?: { email?: string; displayName?: string; self?: boolean };
  calendarId?: string;
}

export interface ListEventsOptions {
  calendarId?: string;
  timeMin?: string;
  timeMax?: string;
  q?: string;
  maxResults?: number;
}

export async function listEvents(
  app: Application,
  userId: number | string,
  opts: ListEventsOptions = {},
): Promise<CalendarEvent[]> {
  const calendarId = opts.calendarId;
  const base = calendarId ? `/me/calendars/${encodeURIComponent(calendarId)}/calendarView` : `/me/calendarView`;
  const params = new URLSearchParams();
  const timeMin = opts.timeMin || new Date().toISOString();
  const timeMax = opts.timeMax || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  params.set('startDateTime', timeMin);
  params.set('endDateTime', timeMax);
  params.set('$orderby', 'start/dateTime');
  params.set('$top', String(Math.min(opts.maxResults || 25, 100)));
  const init: RequestInit = {};
  if (opts.q) {
    params.set('$search', JSON.stringify(opts.q));
    init.headers = { ConsistencyLevel: 'eventual' };
  }
  const res = await authFetch(app, userId, `${base}?${params.toString()}`, init);
  return ((res?.value || []) as any[]).map((e) => ({ ...normalizeEvent(e), calendarId: calendarId || 'primary' }));
}

/**
 * List upcoming events across every non-default calendar the user has
 * access to. Graph's model differs from Google's: `/me/calendars` only
 * returns calendars the user owns or has explicitly added to their own
 * calendar list — there is no implicit "shared with me" set the way Google
 * Calendar exposes one. This mirrors the shape of the Google plugin's
 * `listSharedEvents` (skip the primary calendar, aggregate the rest) but the
 * underlying semantics depend entirely on what the user has added.
 */
export async function listSharedEvents(
  app: Application,
  userId: number | string,
  opts: Omit<ListEventsOptions, 'calendarId'> = {},
): Promise<CalendarEvent[]> {
  const calendars = await listCalendars(app, userId);
  const nonPrimary = calendars.filter((c) => !c.primary);
  const results: CalendarEvent[] = [];
  for (const cal of nonPrimary) {
    try {
      const events = await listEvents(app, userId, { ...opts, calendarId: cal.id });
      results.push(...events);
    } catch {
      // skip calendars we can't read
    }
  }
  return results.sort((a, b) => startTime(a).localeCompare(startTime(b)));
}

export interface CreateEventInput {
  calendarId?: string;
  summary: string;
  description?: string;
  location?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: Array<{ email: string; optional?: boolean }>;
}

export async function createEvent(
  app: Application,
  userId: number | string,
  input: CreateEventInput,
): Promise<CalendarEvent> {
  const calendarId = input.calendarId;
  const base = calendarId ? `/me/calendars/${encodeURIComponent(calendarId)}/events` : `/me/events`;
  const body = toGraphEvent(input);
  const res = await authFetch(app, userId, base, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return { ...normalizeEvent(res), calendarId: calendarId || 'primary' };
}

export interface UpdateEventInput {
  calendarId?: string;
  eventId: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: Array<{ email: string; optional?: boolean }>;
}

export async function updateEvent(
  app: Application,
  userId: number | string,
  input: UpdateEventInput,
): Promise<CalendarEvent> {
  const patch: Record<string, unknown> = {};
  if (input.summary !== undefined) patch.subject = input.summary;
  if (input.description !== undefined) patch.body = { contentType: 'Text', content: input.description };
  if (input.location !== undefined) patch.location = { displayName: input.location };
  if (input.start !== undefined) patch.start = toGraphDateTime(input.start);
  if (input.end !== undefined) patch.end = toGraphDateTime(input.end);
  if (input.attendees !== undefined) patch.attendees = toGraphAttendees(input.attendees);
  // Events are addressable by id directly under /me/events regardless of
  // which calendar they live in.
  const res = await authFetch(app, userId, `/me/events/${encodeURIComponent(input.eventId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return { ...normalizeEvent(res), calendarId: input.calendarId || 'primary' };
}

export async function deleteEvent(
  app: Application,
  userId: number | string,
  input: { calendarId?: string; eventId: string },
): Promise<{ deleted: true; eventId: string; calendarId: string }> {
  await authFetch(app, userId, `/me/events/${encodeURIComponent(input.eventId)}`, { method: 'DELETE' });
  return { deleted: true, eventId: input.eventId, calendarId: input.calendarId || 'primary' };
}

function toGraphDateTime(v: { dateTime?: string; date?: string; timeZone?: string }) {
  if (v.date) return { dateTime: `${v.date}T00:00:00`, timeZone: v.timeZone || 'UTC' };
  return { dateTime: v.dateTime, timeZone: v.timeZone || 'UTC' };
}

function toGraphAttendees(attendees: Array<{ email: string; optional?: boolean }>) {
  return attendees.map((a) => ({
    emailAddress: { address: a.email },
    type: a.optional ? 'optional' : 'required',
  }));
}

function toGraphEvent(input: CreateEventInput) {
  return {
    subject: input.summary,
    body: input.description ? { contentType: 'Text', content: input.description } : undefined,
    location: input.location ? { displayName: input.location } : undefined,
    start: toGraphDateTime(input.start),
    end: toGraphDateTime(input.end),
    attendees: input.attendees ? toGraphAttendees(input.attendees) : undefined,
  };
}

function normalizeEvent(e: any): CalendarEvent {
  return {
    id: e.id,
    status: e.isCancelled ? 'cancelled' : 'confirmed',
    summary: e.subject,
    description: e.body?.content,
    location: e.location?.displayName,
    start: e.start ? { dateTime: e.start.dateTime, timeZone: e.start.timeZone } : undefined,
    end: e.end ? { dateTime: e.end.dateTime, timeZone: e.end.timeZone } : undefined,
    htmlLink: e.webLink,
    attendees: (e.attendees || []).map((a: any) => ({
      email: a.emailAddress?.address,
      responseStatus: a.status?.response,
      organizer: false,
      self: false,
    })),
    organizer: e.organizer
      ? { email: e.organizer.emailAddress?.address, displayName: e.organizer.emailAddress?.name }
      : undefined,
  };
}

function startTime(e: CalendarEvent): string {
  return e.start?.dateTime || e.start?.date || '';
}
