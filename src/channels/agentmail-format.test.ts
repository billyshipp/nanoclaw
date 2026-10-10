import { describe, it, expect } from 'vitest';

import { formatInboundText, parseInboundAllow, senderAllowed } from './agentmail.js';

describe('agentmail inbound allowlist', () => {
  it('routes every sender when unset or empty', () => {
    expect(parseInboundAllow(undefined)).toBeNull();
    expect(parseInboundAllow(' , ')).toBeNull();
    expect(senderAllowed('anyone@example.com', null)).toBe(true);
  });

  it('matches exact addresses case-insensitively and @domain suffixes', () => {
    const allow = parseInboundAllow('Billy@NuWaves.xyz, @mail.instinct.com');
    expect(senderAllowed('billy@nuwaves.xyz', allow)).toBe(true);
    expect(senderAllowed('BillyShipp@mail.instinct.com', allow)).toBe(true);
    expect(senderAllowed('billy@nuwaves.xyz.evil.com', allow)).toBe(false);
    expect(senderAllowed('vendor@ziprent.com', allow)).toBe(false);
  });
});

describe('agentmail inbound formatting', () => {
  it('prefixes a header and prefers extracted text', () => {
    const text = formatInboundText({
      messageId: 'm1',
      threadId: 't1',
      from: 'Billy <billy@nuwaves.xyz>',
      subject: 'Quote',
      text: 'new\n\n> quoted history',
      extractedText: 'new',
      attachments: [{ attachmentId: 'a1', filename: 'q.pdf', size: 2_500_000 }],
    });
    expect(text).toBe(
      '[email] From: Billy <billy@nuwaves.xyz>\nSubject: Quote\nthread_id: t1 | message_id: m1\n' +
        'Attachments: q.pdf (2.4 MB, id a1)\n\nnew',
    );
  });

  it('falls back to full text and a placeholder subject', () => {
    const text = formatInboundText({ messageId: 'm2', from: 'x@y.z', text: 'hello' });
    expect(text).toContain('Subject: (no subject)');
    expect(text.endsWith('\n\nhello')).toBe(true);
  });
});
