import { createTelegramAdapter } from '@chat-adapter/telegram';
import { describe, expect, it } from 'vitest';

import { patchMailtoRendering } from './telegram.js';

function renderer(): (md: string) => string {
  const adapter = createTelegramAdapter({ botToken: '1:test', mode: 'polling' });
  patchMailtoRendering(adapter);
  const converter = (adapter as unknown as { formatConverter: { renderPostable(m: { markdown: string }): string } })
    .formatConverter;
  return (md) => converter.renderPostable({ markdown: md });
}

describe('Telegram mailto rendering', () => {
  const render = renderer();

  it('renders an underscore email as escaped text, not an unescaped mailto link', () => {
    const out = render('• *Muse email:* sent from olivia_claw@agentmail.to at 8:54pm.\n• *Memory:* updated.');
    expect(out).not.toContain('mailto:');
    expect(out).toContain('olivia\\_claw@agentmail\\.to');
    // Every unescaped italic marker must pair up.
    expect((out.match(/(?<!\\)_/g) ?? []).length % 2).toBe(0);
  });

  it('handles explicit mailto links with an underscore', () => {
    expect(render('write [Muse](mailto:muse_claw@agentmail.to)')).toBe('write Muse');
  });

  it('leaves safe mailto links and other links as links', () => {
    expect(render('mail billy@example.com')).toContain('(mailto:billy@example.com)');
    expect(render('[docs](https://example.com/a_b)')).toBe('[docs](https://example.com/a_b)');
  });
});
