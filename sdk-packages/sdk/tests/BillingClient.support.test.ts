// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { BillingClient } from '../src/core/BillingClient';

// BillingClient.createSupportTicket contract:
// - JSON branch: Content-Type=application/json, body contains subject/content/customer_email
// - Multipart branch: FormData (Content-Type isn't set explicitly, the browser sets the boundary itself),
//   files are attached as 'files', email is taken from identity.email if not passed in the payload.

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function makeClient(opts: { identity?: { email?: string; userId?: string } } = {}): {
  client: BillingClient;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchMock: typeof fetch = vi.fn(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    calls.push({ url, init: init ?? {} });
    return jsonResp({ ticket: { id: 42, status: 'open' } });
  });
  const client = new BillingClient({
    paywallId: 'pw_1',
    apiOrigin: 'https://api.test',
    identity: opts.identity,
    fetch: fetchMock
  });
  return { client, calls };
}

describe('BillingClient.createSupportTicket', () => {
  it('json mode: posts subject/content/customer_email when no files', async () => {
    const { client, calls } = makeClient({ identity: { email: 'u@x.com' } });
    const res = await client.createSupportTicket({
      subject: 'Help me',
      content: 'I have a problem'
    });
    expect(res.ticket.id).toBe(42);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.test/api/v1/paywall/pw_1/support/ticket');
    expect((calls[0].init.headers as Headers).get('Content-Type')).toBe('application/json');
    const body = JSON.parse(calls[0].init.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      subject: 'Help me',
      content: 'I have a problem',
      customer_email: 'u@x.com'
    });
  });

  it('explicit email in payload overrides identity.email', async () => {
    const { client, calls } = makeClient({ identity: { email: 'identity@x.com' } });
    await client.createSupportTicket({
      subject: 'Q',
      content: 'msg',
      email: 'explicit@x.com'
    });
    const body = JSON.parse(calls[0].init.body as string) as Record<string, unknown>;
    expect(body.customer_email).toBe('explicit@x.com');
  });

  it('no identity, no explicit email → customer_email is null (server enforces)', async () => {
    const { client, calls } = makeClient();
    await client.createSupportTicket({ subject: 'Q', content: 'msg' });
    const body = JSON.parse(calls[0].init.body as string) as Record<string, unknown>;
    expect(body.customer_email).toBeNull();
  });

  it('multipart mode: FormData with files when files provided', async () => {
    const { client, calls } = makeClient({ identity: { email: 'u@x.com' } });
    const file = new File(['fake'], 'screenshot.png', { type: 'image/png' });
    await client.createSupportTicket({
      subject: 'Bug',
      content: 'See attached',
      files: [file]
    });
    expect(calls).toHaveLength(1);
    // The browser sets the multipart boundary itself — we must NOT send application/json.
    const ct = (calls[0].init.headers as Headers).get('Content-Type') || '';
    expect(ct).not.toContain('application/json');
    expect(calls[0].init.body).toBeInstanceOf(FormData);
    const fd = calls[0].init.body as FormData;
    expect(fd.get('subject')).toBe('Bug');
    expect(fd.get('content')).toBe('See attached');
    expect(fd.get('customer_email')).toBe('u@x.com');
    const fileEntries = fd.getAll('files');
    expect(fileEntries).toHaveLength(1);
    expect((fileEntries[0] as File).name).toBe('screenshot.png');
  });
});
