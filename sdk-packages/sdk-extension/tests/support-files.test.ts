// @vitest-environment jsdom
// Regression: support-ticket attachments through the transport. chrome.runtime
// ports JSON-serialize messages, so a File in request params silently degrades
// to `{}` — the ticket used to arrive without the screenshot and without any
// error (the backend filters non-File multipart entries). The fix ships file
// bytes as base64 via `billing.stageSupportFile` and rebuilds Files in
// offscreen.
//
// Unlike paywall-ui.test.ts (stub TransportServer), this suite instantiates
// the REAL OffscreenServer so the staging handlers themselves are under test,
// and the in-memory channel JSON-roundtrips every envelope — exactly what the
// chrome port does to our payloads in prod.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { PaywallError } from '@sdk/core/types';
import { TransportClient } from '../src/shared/transport-client';
import { RemoteBillingClient } from '../src/content/RemoteBillingClient';
import { bytesToBase64, base64ToBytes } from '../src/shared/base64';
import { MAX_SUPPORT_FILE_SIZE, MAX_SUPPORT_FILES } from '../src/shared/support-limits';
import { OffscreenServer } from '../src/offscreen/server';
import type { MessageChannel } from '../src/shared/channel';
import type { Envelope } from '../src/shared/protocol';
import '../src/shared/messages';

// jsdom's Blob lacks arrayBuffer() (Chrome has it since 76 — the extension
// baseline is far above). Polyfill through FileReader, which jsdom does implement.
if (typeof Blob.prototype.arrayBuffer !== 'function') {
  Blob.prototype.arrayBuffer = function (this: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}

/** In-memory channel pair that JSON-roundtrips every envelope — the same
 *  serialization chrome.runtime ports apply. Files/ArrayBuffers die here,
 *  strings survive: the whole point of the staging protocol. */
function jsonPairChannels(): [MessageChannel, MessageChannel] {
  const aIn = new Set<(env: Envelope) => void>();
  const bIn = new Set<(env: Envelope) => void>();
  const noop = (): (() => void) => () => {};
  const deliver = (targets: Set<(env: Envelope) => void>, env: Envelope): void => {
    const wire = JSON.parse(JSON.stringify(env)) as Envelope;
    for (const cb of targets) cb(wire);
  };
  return [
    {
      send: (env) => deliver(bIn, env),
      onMessage: (cb) => {
        aIn.add(cb);
        return () => aIn.delete(cb);
      },
      onDisconnect: () => noop(),
      close: () => {}
    },
    {
      send: (env) => deliver(aIn, env),
      onMessage: (cb) => {
        bIn.add(cb);
        return () => bIn.delete(cb);
      },
      onDisconnect: () => noop(),
      close: () => {}
    }
  ];
}

function jpegBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) % 256;
  return bytes;
}

function setup() {
  const ticketRequests: Array<{ url: string; body: FormData | string }> = [];
  const fetchStub = vi.fn(async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('/support/ticket')) {
      ticketRequests.push({ url: u, body: init?.body as FormData | string });
      return new Response(JSON.stringify({ ticket: { id: 42, status: 'open' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }) as unknown as Response;
    }
    return new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }) as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchStub);

  // The real offscreen server — auth off, analytics off: only billing matters here.
  const server = new OffscreenServer({
    paywallId: 'demo',
    apiOrigin: 'https://t.local',
    analytics: false
  });
  const [contentCh, offscreenCh] = jsonPairChannels();
  server.acceptChannel(offscreenCh);

  const remote = new RemoteBillingClient(new TransportClient(() => contentCh), {
    paywallId: 'demo',
    apiOrigin: 'https://t.local'
  });
  return { remote, server, ticketRequests, fetchStub };
}

describe('support-ticket attachments over a JSON-serializing transport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('regression: file bytes, name and mime survive content → offscreen → fetch', async () => {
    const { remote, ticketRequests } = setup();
    const bytes = jpegBytes(64 * 1024);
    const file = new File([bytes as unknown as BlobPart], 'screenshot.jpg', {
      type: 'image/jpeg'
    });

    const result = await remote.createSupportTicket({
      subject: 'Bug report',
      content: 'see attached',
      email: 'user@test.local',
      files: [file]
    });

    expect(result.ticket.id).toBe(42);
    expect(ticketRequests).toHaveLength(1);
    const body = ticketRequests[0].body;
    // The old code shipped the File straight through the JSON wire: FormData
    // then contained the string "[object Object]" and the backend dropped it.
    expect(body).toBeInstanceOf(FormData);
    const sent = (body as FormData).getAll('files');
    expect(sent).toHaveLength(1);
    const sentFile = sent[0] as File;
    expect(sentFile).toBeInstanceOf(File);
    expect(sentFile.name).toBe('screenshot.jpg');
    expect(sentFile.type).toBe('image/jpeg');
    const sentBytes = new Uint8Array(await sentFile.arrayBuffer());
    expect(sentBytes).toEqual(bytes);
  });

  it('multiple files arrive in order', async () => {
    const { remote, ticketRequests } = setup();
    const files = [
      new File([jpegBytes(1024) as unknown as BlobPart], 'a.jpg', { type: 'image/jpeg' }),
      new File([jpegBytes(2048) as unknown as BlobPart], 'b.png', { type: 'image/png' })
    ];

    await remote.createSupportTicket({ subject: 'Two files', content: 'x', files });

    const sent = (ticketRequests[0].body as FormData).getAll('files') as File[];
    expect(sent.map((f) => f.name)).toEqual(['a.jpg', 'b.png']);
    expect(sent.map((f) => f.size)).toEqual([1024, 2048]);
  });

  it('oversized file is rejected on the content side, nothing crosses the wire', async () => {
    const { remote, ticketRequests, fetchStub } = setup();
    const file = new File(
      [jpegBytes(MAX_SUPPORT_FILE_SIZE + 1) as unknown as BlobPart],
      'huge.jpg',
      { type: 'image/jpeg' }
    );

    await expect(
      remote.createSupportTicket({ subject: 'Too big', content: 'x', files: [file] })
    ).rejects.toMatchObject({ code: 'invalid_file' });
    expect(ticketRequests).toHaveLength(0);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('more than MAX_SUPPORT_FILES is rejected with too_many_files', async () => {
    const { remote, fetchStub } = setup();
    const files = Array.from(
      { length: MAX_SUPPORT_FILES + 1 },
      (_, i) => new File([jpegBytes(8) as unknown as BlobPart], `f${i}.jpg`, { type: 'image/jpeg' })
    );

    await expect(
      remote.createSupportTicket({ subject: 'Too many', content: 'x', files })
    ).rejects.toMatchObject({ code: 'too_many_files' });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('errors reconstruct as PaywallError across the wire (expired stage id)', async () => {
    const { remote } = setup();
    // Bypass RemoteBillingClient staging: reference an id nobody staged. The
    // offscreen handler must fail loudly — a silent skip would recreate the
    // "ticket without the screenshot" bug.
    const transport = (remote as unknown as { transport: TransportClient }).transport;
    await expect(
      transport.request('billing.createSupportTicket', {
        subject: 'Stale',
        content: 'x',
        fileIds: ['00000000-0000-0000-0000-000000000000']
      })
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof PaywallError && e.code === 'invalid_file'
    );
  });

  it('base64 helpers roundtrip arbitrary bytes (chunk boundary included)', () => {
    for (const size of [0, 1, 0x7fff, 0x8000, 0x8001, 200_000]) {
      const bytes = jpegBytes(size);
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    }
  });
});
