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
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Microsoft Graph mail API ${res.status}: ${body}`);
  }
  if (res.status === 202 || res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export interface EmailSummary {
  id: string;
  from?: string;
  to?: string;
  subject?: string;
  snippet?: string;
  date?: string;
  unread: boolean;
}

export async function listEmails(
  app: Application,
  userId: number | string,
  opts: { query?: string; maxResults?: number; folder?: string } = {},
): Promise<EmailSummary[]> {
  const folder = opts.folder || 'inbox';
  const params = new URLSearchParams();
  params.set('$top', String(Math.min(opts.maxResults || 10, 50)));
  params.set(
    '$select',
    'id,subject,from,toRecipients,bodyPreview,receivedDateTime,isRead',
  );
  const init: RequestInit = {};
  if (opts.query) {
    // $search requires the eventual-consistency header and cannot be
    // combined with $orderby.
    params.set('$search', JSON.stringify(opts.query));
    init.headers = { ConsistencyLevel: 'eventual' };
  } else {
    params.set('$orderby', 'receivedDateTime desc');
  }
  const list = await authFetch(
    app,
    userId,
    `/me/mailFolders/${encodeURIComponent(folder)}/messages?${params.toString()}`,
    init,
  );
  return ((list?.value || []) as any[]).map(toSummary);
}

export interface EmailDetail extends EmailSummary {
  bodyText?: string;
  bodyHtml?: string;
}

export async function getEmail(app: Application, userId: number | string, id: string): Promise<EmailDetail> {
  const full = await authFetch(
    app,
    userId,
    `/me/messages/${encodeURIComponent(id)}?$select=id,subject,from,toRecipients,bodyPreview,receivedDateTime,isRead,body`,
  );
  const summary = toSummary(full);
  const contentType: string = full?.body?.contentType || 'text';
  const content: string | undefined = full?.body?.content;
  return {
    ...summary,
    bodyText: contentType === 'text' ? content : undefined,
    bodyHtml: contentType === 'html' ? content : undefined,
  };
}

export interface SendEmailInput {
  to: string | string[];
  subject: string;
  body: string;
  cc?: string | string[];
  bcc?: string | string[];
  isHtml?: boolean;
}

export async function sendEmail(
  app: Application,
  userId: number | string,
  input: SendEmailInput,
): Promise<{ sent: true }> {
  const message = {
    subject: input.subject,
    body: { contentType: input.isHtml ? 'HTML' : 'Text', content: input.body },
    toRecipients: toRecipients(input.to),
    ccRecipients: toRecipients(input.cc),
    bccRecipients: toRecipients(input.bcc),
  };
  await authFetch(app, userId, `/me/sendMail`, {
    method: 'POST',
    body: JSON.stringify({ message, saveToSentItems: true }),
  });
  // Graph's sendMail returns 202 Accepted with no body and no message id.
  return { sent: true };
}

function toRecipients(v?: string | string[]) {
  if (!v) return undefined;
  const list = Array.isArray(v) ? v : [v];
  return list.filter(Boolean).map((address) => ({ emailAddress: { address } }));
}

function toSummary(msg: any): EmailSummary {
  return {
    id: msg.id,
    from: msg.from?.emailAddress?.address,
    to: (msg.toRecipients || []).map((r: any) => r.emailAddress?.address).filter(Boolean).join(', '),
    subject: msg.subject,
    snippet: msg.bodyPreview,
    date: msg.receivedDateTime,
    unread: msg.isRead === false,
  };
}
