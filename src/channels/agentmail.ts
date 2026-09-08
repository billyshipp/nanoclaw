/**
 * AgentMail channel adapter (native — no Chat SDK bridge exists for AgentMail).
 *
 * Bridges NanoClaw with an AgentMail-managed inbox (https://agentmail.to). Each
 * external correspondent is a separate messaging group, platformId
 * "agentmail:<their-address>" — same flattened model as the Resend adapter,
 * chosen for parity: one NanoClaw session per correspondent, regardless of how
 * many distinct email subject-threads they start.
 *
 * Polling, not webhooks: AgentMail supports both, but a webhook needs a public
 * HTTPS endpoint reachable from AgentMail's servers, which not every install
 * has. Polling needs nothing but outbound API calls. Unlike Resend's adapter,
 * AgentMail's SDK can originate a brand-new thread (`messages.send`) as well
 * as reply within one (`messages.reply`), so there is no cold-start
 * limitation — the bot can email a correspondent first.
 *
 * Required env vars (.env): AGENTMAIL_API_KEY, AGENTMAIL_INBOX_ID
 * Optional env vars (.env): AGENTMAIL_POLL_INTERVAL_MS (default: 30000)
 */
import { AgentMailClient } from 'agentmail';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const REQUIRED_ENV = ['AGENTMAIL_API_KEY', 'AGENTMAIL_INBOX_ID'] as const;
const OPTIONAL_ENV = ['AGENTMAIL_POLL_INTERVAL_MS'] as const;
type AgentMailEnv = { [K in (typeof REQUIRED_ENV)[number]]: string } & {
  [K in (typeof OPTIONAL_ENV)[number]]?: string;
};

const DEFAULT_POLL_INTERVAL_MS = 30_000;
// Safety-net dedup across poll ticks — boundary messages at the exact
// `after` cutoff could otherwise be delivered twice. Bounded so it never
// grows unbounded over a long-running process.
const MAX_SEEN_IDS = 500;

/** "user@domain.com" or "Display Name <user@domain.com>" → bare address. */
function extractAddress(from: string): string | null {
  const angleMatch = from.match(/<([^>]+)>/);
  const addr = (angleMatch ? angleMatch[1] : from).trim();
  return addr.includes('@') ? addr : null;
}

function createAdapter(env: AgentMailEnv): ChannelAdapter {
  const client = new AgentMailClient({ apiKey: env.AGENTMAIL_API_KEY });
  const inboxId = env.AGENTMAIL_INBOX_ID;
  const pollIntervalMs = env.AGENTMAIL_POLL_INTERVAL_MS
    ? parseInt(env.AGENTMAIL_POLL_INTERVAL_MS, 10)
    : DEFAULT_POLL_INTERVAL_MS;

  // Reply-vs-cold-send state: the last inbound message id per correspondent,
  // so a reply threads properly via AgentMail's own In-Reply-To handling.
  // In-memory only — a host restart falls back to a cold send for that
  // correspondent's next reply, same tradeoff as Resend's ThreadResolver.
  const lastInboundMessageId = new Map<string, string>();
  const seenMessageIds = new Set<string>();
  let lastPollTime = new Date();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let polling = false;
  let connected = false;

  async function pollOnce(config: ChannelSetup): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      const since = lastPollTime;
      let pageToken: string | undefined;
      const items: Array<{
        messageId: string;
        from: string;
        createdAt: Date;
      }> = [];

      do {
        const res = await client.inboxes.messages.list(inboxId, {
          after: since,
          labels: ['received'],
          limit: 50,
          pageToken,
        });
        for (const m of res.messages) items.push({ messageId: m.messageId, from: m.from, createdAt: m.createdAt });
        pageToken = res.nextPageToken;
      } while (pageToken);

      if (items.length === 0) return;

      items.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

      for (const item of items) {
        if (seenMessageIds.has(item.messageId)) continue;
        seenMessageIds.add(item.messageId);
        if (seenMessageIds.size > MAX_SEEN_IDS) {
          const oldest = seenMessageIds.values().next().value;
          if (oldest !== undefined) seenMessageIds.delete(oldest);
        }

        const address = extractAddress(item.from);
        if (!address) {
          log.warn('AgentMail: could not extract sender address', { from: item.from });
          continue;
        }

        const platformId = `agentmail:${address}`;
        lastInboundMessageId.set(platformId, item.messageId);

        try {
          const full = await client.inboxes.messages.get(inboxId, item.messageId);
          await config.onInbound(platformId, null, {
            id: item.messageId,
            kind: 'chat',
            content: {
              text: full.text || full.extractedText || '',
              sender: address,
              senderId: address,
            },
            timestamp: item.createdAt.toISOString(),
            isGroup: false,
            isMention: true,
          });
        } catch (err) {
          log.error('AgentMail: error handling incoming message', { err, messageId: item.messageId });
        }
      }

      lastPollTime = items[items.length - 1].createdAt;
    } catch (err) {
      log.error('AgentMail: poll failed', { err });
    } finally {
      polling = false;
    }
  }

  return {
    name: 'agentmail',
    channelType: 'agentmail',
    supportsThreads: false,
    defaults: AGENTMAIL_DEFAULTS,

    async setup(config: ChannelSetup): Promise<void> {
      // Fail fast on bad credentials / unknown inbox before starting the poll loop.
      await client.inboxes.get(inboxId);
      connected = true;
      lastPollTime = new Date();

      pollTimer = setInterval(() => {
        void pollOnce(config);
      }, pollIntervalMs);

      log.info('AgentMail: adapter ready, polling started', { inboxId, pollIntervalMs });
    },

    async teardown(): Promise<void> {
      if (pollTimer) clearInterval(pollTimer);
      connected = false;
    },

    isConnected(): boolean {
      return connected;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      const address = platformId.replace(/^agentmail:/, '');
      const content = message.content as Record<string, unknown>;
      const text = typeof content.text === 'string' ? content.text : '';
      if (!text) return undefined;

      const replyToId = lastInboundMessageId.get(platformId);
      if (replyToId) {
        const res = await client.inboxes.messages.reply(inboxId, replyToId, { text });
        return res.messageId;
      }

      const res = await client.inboxes.messages.send(inboxId, {
        to: [address],
        subject: 'Message from your NanoClaw assistant',
        text,
      });
      return res.messageId;
    },
  };
}

/**
 * Dedicated inbox identity, so request_approval is sound. Email carries no
 * mention metadata ('dm-only'; the adapter flags DMs only), so group wirings
 * default to a name-pattern trigger. supportsThreads: false — see the adapter
 * doc comment for the flattened-per-correspondent model.
 */
const AGENTMAIL_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: {
    engageMode: 'pattern',
    engagePattern: '\\b{name}\\b',
    threads: false,
    unknownSenderPolicy: 'request_approval',
  },
  mentions: 'dm-only',
};

registerChannelAdapter('agentmail', {
  factory: () => {
    const env = readEnvFile([...REQUIRED_ENV, ...OPTIONAL_ENV]);
    if (!env.AGENTMAIL_API_KEY || !env.AGENTMAIL_INBOX_ID) return null;
    return createAdapter(env as AgentMailEnv);
  },
  defaults: AGENTMAIL_DEFAULTS,
});
