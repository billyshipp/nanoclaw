---
name: add-agentmail
description: Add AgentMail (email) channel integration — a fully-managed agent inbox via API, no DNS/MX ownership required.
---

# Add AgentMail Email Channel

Connect NanoClaw to email via [AgentMail](https://www.agentmail.to) — an email
inbox API built specifically for AI agents. Unlike a channel built on your own
domain's mail routing (e.g. Resend), AgentMail provisions and hosts the inbox
itself, so there is no MX record to add or conflict with an existing mail
provider on your domain.

NanoClaw doesn't ship channels in trunk — this skill copies the AgentMail
adapter in from the `channels` branch. There is no official Chat SDK adapter
for AgentMail, so this is a **native** adapter (like DeltaChat, WhatsApp,
Signal): it talks to the `agentmail` SDK directly and registers its own raw
webhook route.

## Apply

### 1. Copy the adapter

Fetch the `channels` branch and copy the AgentMail adapter into
`src/channels/` (overwrite — the branch is canonical):

```bash
git fetch origin channels
git show origin/channels:src/channels/agentmail.ts > src/channels/agentmail.ts
git show origin/channels:src/channels/agentmail-registration.test.ts > src/channels/agentmail-registration.test.ts
```

### 2. Register the adapter

Append the self-registration import to the channel barrel (skip if the line
is already present):

```typescript
// src/channels/index.ts
import './agentmail.js';
```

### 3. Install the adapter's dependencies

Pinned to exact versions — the supply-chain policy rejects ranges and
`latest`:

```bash
pnpm add agentmail@0.5.23 svix@2.3.0
```

`agentmail` is AgentMail's own Node SDK (inbox, message, and webhook
management). `svix` verifies inbound webhook signatures — AgentMail delivers
webhooks via Svix and hands you a per-webhook secret to verify against.

### 4. Build and validate

Build guards the adapter's typed use of the `agentmail` SDK; the registration
test proves both dependencies are actually installed (the adapter imports
both — if either is missing, the barrel throws on import).

```bash
pnpm run build
pnpm exec vitest run src/channels/agentmail-registration.test.ts
```

`agentmail-registration.test.ts` imports the real channel barrel and asserts
the registry contains `agentmail`. It goes red if the import line is deleted
or drifts, if the barrel fails to evaluate, or if either `agentmail` or
`svix` isn't installed (the import throws).

## Credentials

Inbox and webhook setup is human and interactive — these steps are prose, not
a script. A recipe rebuild produces a compiling, registered adapter that
cannot receive a message until they're done.

1. Go to [agentmail.to](https://www.agentmail.to) and create an account.
2. In the dashboard, go to **Inboxes** → **+ Create Inbox**. On the free plan
   the domain defaults to `agentmail.to` (e.g. `yourbot@agentmail.to`); pick a
   username, or bring a verified custom domain if you have one. Copy the
   **Inbox ID**.
3. Go to **API Keys** → **Create New API Key**. Copy it immediately — it is
   shown only once.
4. Go to **Webhooks** → **Create Webhook**:
   - URL: `https://your-domain/webhook/agentmail`
   - Event types: `message.received`
   - Copy the webhook's **secret** (used for Svix signature verification).

### Store the credentials

```bash
# Ensure .env has these three (set-if-absent — never overwrite a value you've already filled in)
grep -q '^AGENTMAIL_API_KEY=' .env || echo 'AGENTMAIL_API_KEY=<paste API key>' >> .env
grep -q '^AGENTMAIL_INBOX_ID=' .env || echo 'AGENTMAIL_INBOX_ID=<paste inbox id>' >> .env
grep -q '^AGENTMAIL_WEBHOOK_SECRET=' .env || echo 'AGENTMAIL_WEBHOOK_SECRET=<paste webhook secret>' >> .env
```

Rebuild the container image if any group needs it, then restart the service so
it picks up the new `.env` values and the registered `agentmail` webhook
route:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
# systemctl --user restart nanoclaw                # Linux
```

## Connect yourself

Because AgentMail can originate a new thread (unlike a Resend-style adapter,
which can only reply within a thread it received), the bot really can write
to you first. Wire your own address as owner and have it email you a hello.
Tell it your address and which agent should answer your email (`ncl groups
list` shows their folders):

```bash
ncl users create --id agentmail:<your-address> --kind agentmail --display-name Owner
ncl roles grant --user agentmail:<your-address> --role owner
ncl messaging-groups create --channel-type agentmail --platform-id agentmail:<your-address> --is-group 0
ncl wirings create --channel-type agentmail --platform-id agentmail:<your-address> --agent-group <agent-folder> --engage-mode pattern --engage-pattern .
ncl messaging-groups send --channel-type agentmail --platform-id agentmail:<your-address> --sender-id agentmail:<your-address> --sender Owner --text "Hi — I'm your NanoClaw assistant, reachable by email now. Reply to this thread anytime."
```

The last command injects a synthetic inbound message to wake the agent, which
then composes and sends the real first email via `messages.send`. Reply to
that email to keep the conversation going.

Consider granting a role scoped to one agent group instead of a global
`owner`, per your own risk tolerance — see `ncl roles help grant`.

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now. (Answering
an *open* inbox — anyone who emails in, not just you — is a separate,
not-yet-wired case: email is plain-message, so the router never auto-creates
a group for an unknown sender; each correspondent's `agentmail:<their-address>`
must be wired explicitly, or use `ncl members add` after an unknown-sender
approval card fires.)

## Channel Info

- **type**: `agentmail`
- **terminology**: one AgentMail inbox (`AGENTMAIL_INBOX_ID`) is the bot's
  fixed sending identity; every *external correspondent* the bot emails with
  is a separate conversation, keyed by *their* address.
- **how-to-find-id**: the platform ID is the **correspondent's** email
  address, prefixed — `agentmail:<their-address>` — **not** the inbox's own
  address. The adapter derives it from the webhook's `message.from` field.
- **supports-threads**: no — every email from one correspondent (regardless
  of subject) lands in the same NanoClaw session, matching the Resend
  adapter's model. AgentMail's own thread/message IDs are still used
  internally so replies land in the correct email thread from the
  correspondent's point of view.
- **typical-use**: async communication — email conversations with longer
  response expectations.
- **default-isolation**: same agent group if you want your agent to handle
  email alongside other channels. Separate agent group if email contains
  sensitive correspondence that shouldn't be accessible from other channels.

## Troubleshooting

**Sends fail with 401 from AgentMail.** The API key comes from the dashboard's
**API Keys** page and is shown only once at creation — if in doubt, create a
new one and update `AGENTMAIL_API_KEY` in `.env`.

**Webhook signature verification fails (every inbound email is dropped with a
`401`).** `AGENTMAIL_WEBHOOK_SECRET` must match the secret shown for the
*specific* webhook pointed at `/webhook/agentmail` — each webhook has its own
secret. Re-copy it from the dashboard's **Webhooks** page if in doubt.

**Replies never reach the agent.** Confirm the webhook in the dashboard is
enabled, points at your public host's `/webhook/agentmail` (shared webhook
server, port 3000), and has `message.received` selected. The dashboard's
webhook page lists recent delivery attempts — a run of failures usually means
the URL is unreachable from AgentMail's servers (check firewall/reverse proxy
in front of port 3000).

**Adapter installed but nothing flows.** Run `pnpm exec vitest run
src/channels/agentmail-registration.test.ts` — red means the barrel import or
one of the two package installs (`agentmail`, `svix`) drifted, so re-run the
Apply steps. If green, restart the service so it loads the adapter and
`.env`, then re-send the hello.
