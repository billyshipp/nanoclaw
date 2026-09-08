/**
 * AgentMail channel adapter (native — no Chat SDK bridge exists for AgentMail).
 *
 * Bridges NanoClaw with an AgentMail-managed inbox (https://agentmail.to). Each
 * external correspondent is a separate messaging group, platformId
 * "agentmail:<their-address>" — same flattened model as the Resend adapter,
 * chosen for parity: one NanoClaw session per correspondent, regardless of how
 * many distinct email subject-threads they start. Unlike Resend's adapter,
 * AgentMail's SDK can originate a brand-new thread (`messages.send`) as well as
 * reply within one (`messages.reply`), so there is no cold-start limitation —
 * the bot can email a correspondent first.
 *
 * Required env vars (.env): AGENTMAIL_API_KEY, AGENTMAIL_INBOX_ID,
 *                           AGENTMAIL_WEBHOOK_SECRET
 */
import { AgentMailClient } from 'agentmail';
import { Webhook as SvixWebhook } from 'svix';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerWebhookHandler } from '../webhook-server.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const REQUIRED_ENV = ['AGENTMAIL_API_KEY', 'AGENTMAIL_INBOX_ID', 'AGENTMAIL_WEBHOOK_SECRET'] as const;
type AgentMailEnv = { [K in (typeof REQUIRED_ENV)[number]]: string };

/** "user@domain.com" or "Display Name <user@domain.com>" → bare address. */
function extractAddress(from: string): string | null {
  const angleMatch = from.match(/<([^>]+)>/);
  const addr = (angleMatch ? angleMatch[1] : from).trim();
  return addr.includes('@') ? addr : null;
}

interface WireMessage {
  message_id: string;
  thread_id: string;
  from: string;
  subject?: string | null;
  text?: string | null;
  extracted_text?: string | null;
}

interface WireEvent {
  type: 'event';
  event_type: string;
  event_id: string;
  message?: WireMessage;
}

function createAdapter(env: AgentMailEnv): ChannelAdapter {
  const client = new AgentMailClient({ apiKey: env.AGENTMAIL_API_KEY });
  const inboxId = env.AGENTMAIL_INBOX_ID;
  const verifier = new SvixWebhook(env.AGENTMAIL_WEBHOOK_SECRET);

  // Reply-vs-cold-send state: the last inbound message id per correspondent,
  // so a reply threads properly via AgentMail's own In-Reply-To handling.
  // In-memory only — a host restart falls back to a cold send for that
  // correspondent's next reply, same tradeoff as Resend's ThreadResolver.
  const lastInboundMessageId = new Map<string, string>();
  let connected = false;

  return {
    name: 'agentmail',
    channelType: 'agentmail',
    supportsThreads: false,
    defaults: AGENTMAIL_DEFAULTS,

    async setup(config: ChannelSetup): Promise<void> {
      // Fail fast on bad credentials / unknown inbox before registering the route.
      await client.inboxes.get(inboxId);
      connected = true;

      registerWebhookHandler('agentmail', async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const payload = Buffer.concat(chunks).toString('utf-8');

        const svixId = req.headers['svix-id'];
        const svixTimestamp = req.headers['svix-timestamp'];
        const svixSignature = req.headers['svix-signature'];
        try {
          verifier.verify(payload, {
            'svix-id': Array.isArray(svixId) ? svixId[0] : (svixId ?? ''),
            'svix-timestamp': Array.isArray(svixTimestamp) ? svixTimestamp[0] : (svixTimestamp ?? ''),
            'svix-signature': Array.isArray(svixSignature) ? svixSignature[0] : (svixSignature ?? ''),
          });
        } catch (err) {
          log.warn('AgentMail: webhook signature verification failed', { err });
          res.writeHead(401, { 'Content-Type': 'text/plain' });
          res.end('invalid signature');
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');

        let event: WireEvent;
        try {
          event = JSON.parse(payload);
        } catch (err) {
          log.error('AgentMail: unparseable webhook payload', { err });
          return;
        }

        if (event.event_type !== 'message.received' || !event.message) return;
        const msg = event.message;
        const address = extractAddress(msg.from);
        if (!address) {
          log.warn('AgentMail: could not extract sender address', { from: msg.from });
          return;
        }

        const platformId = `agentmail:${address}`;
        lastInboundMessageId.set(platformId, msg.message_id);

        try {
          await config.onInbound(platformId, null, {
            id: msg.message_id,
            kind: 'chat',
            content: {
              text: msg.text || msg.extracted_text || '',
              sender: address,
              senderId: address,
            },
            timestamp: new Date().toISOString(),
            isGroup: false,
            isMention: true,
          });
        } catch (err) {
          log.error('AgentMail: error handling incoming message', { err });
        }
      });

      log.info('AgentMail: adapter ready', { inboxId });
    },

    async teardown(): Promise<void> {
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
    const env = readEnvFile([...REQUIRED_ENV]);
    if (!env.AGENTMAIL_API_KEY || !env.AGENTMAIL_INBOX_ID || !env.AGENTMAIL_WEBHOOK_SECRET) return null;
    return createAdapter(env as AgentMailEnv);
  },
  defaults: AGENTMAIL_DEFAULTS,
});
