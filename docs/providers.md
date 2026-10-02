# Provider contracts and evidence

Verified against public primary sources on 2026-10-02 through Composio CLI + Exa.
No owner account or external Bot was used for these checks. Passing tests prove
our server and simulated callback behavior, not a live dots-to-Grok conversation.

## dots

[OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events)
explicitly supports dots and requires MCP 2.0 revision `2026-07-28`.
Events and tools use the same authenticated MCP endpoint. The official SDK adds
the current request/response envelope; HTTP requests include `Mcp-Method`,
`MCP-Protocol-Version`, and protocol/client-capabilities metadata.

- `server/discover` advertises `capabilities.events`.
- `events/list` exposes the `inbox.ready` event, with empty filter arguments.
- `events/subscribe` receives the callback URL and `whsec_` signing key from
  ChatGPT. The user does not find or paste a dots notification URL.
- `events/unsubscribe` identifies a subscription by the authenticated binding,
  event name, arguments, and callback URL.

We verify callbacks with a signed, random, single-use challenge before storing an
active subscription. A successful verification is cached for at most one minute,
scoped to binding, callback URL, and signing key, with a bounded cache size. After
verification, the database lock rechecks binding activity before committing.
One active subscription per binding prevents two subscribed contexts from
silently sharing one inbox. A different context must explicitly unsubscribe the
first one, or wait until it expires.

Subscription IDs hash the authenticated binding, URL, event name, and canonical
arguments. Secrets use AES-256-GCM with the subscription ID as authenticated
context. Key rotation signs with both keys for five minutes. A repeated refresh
does not cut that rotation window short.

The default lifetime is one hour, with a one-day maximum. Shorter requested
lifetimes are honored. Requests for no expiration receive a finite expiration.
Expired subscriptions stop delivery. Protocol replay is not implemented:
`cursor` is null and messages remain in the authenticated inbox.

The Standard Webhooks signature is HMAC-SHA256 of the exact bytes of
`webhook-id.webhook-timestamp.body`. The signing key is the decoded base64 portion
of `whsec_`, restricted to 24–64 bytes. Headers also include
`X-MCP-Subscription-Id`. Delivery preserves the notification ID and occurrence
timestamp across retries; each attempt gets a fresh signing timestamp.

Notifications contain only conversation and message IDs. Peer-authored text is
retrieved with `inbox_claim`; notification IDs do not grant access. A successful
HTTP response records receipt only. Actual consumption and replies are separate
database transitions. `410` disables a subscription; `413` is terminal.

## Grok Bot

[Official routines documentation](https://docs.x.ai/grok-bot/skills-routines-and-automations)
describes routines owned by an existing Bot, background execution, test runs,
and conversation-details management. A
[Cursor staff response](https://forum.cursor.com/t/can-no-longer-edit-a-routine/171677/11)
dated 2026-09-16 confirms that the routine panel exposes a Webhook URL, key, and
Authorization header. It is not a complete webhook API specification.

The experimental transport follows the author-maintained
[grokbot-mcp-bridge specification](https://github.com/kinopeee/grokbot-mcp-bridge/blob/main/SPEC.md):
JSON POST to the UI-issued `https://api2.cursor.sh/automations/webhook/...` URL,
with the UI-issued key as a Bearer credential. This is implementation evidence
from an independent integration, not an xAI API guarantee.

Our experimental payload is our own application contract:

```json
{
  "event": "inbox.ready",
  "notification_id": "opaque-id",
  "conversation_id": "opaque-id",
  "message_id": "opaque-id"
}
```

It deliberately does not implement that other bridge's `run_id`, `request_id`,
or callback-URL convention. Our return path is the authenticated MCP inbox and
turn tools. A configured existing Bot routine must call those tools on receipt.
This behavior remains unverified with an actual Grok Bot account. The adapter
returns `configuration_required` unless the operator explicitly enables the
experimental adapter and supplies a binding-specific webhook URL and key.

The exact personal-Bot onboarding path still requires an account test. The
[2026-09-17 staff correction](https://forum.cursor.com/t/grok-bot-custom-mcp-oauth-fails-before-sign-in-redirect-uri-not-allowed/171877)
states that personal Bot connectors use OAuth and there was no safe UI for
arbitrary secret headers, despite an API-level headers parameter. Do not tell
users to paste a Bearer secret into Bot chat. The same thread documents an
unresolved DCR incompatibility with Cloudflare Access Managed OAuth: Grok's
registration includes a `cursor://` callback that Cloudflare rejects. The full
reported redirect list is:

- `cursor://anysphere.cursor-mcp/oauth/callback`
- `https://www.cursor.com/agents/mcp/oauth/callback`
- `http://localhost:8787/callback`

The [operator-provisioned OAuth pilot](oauth.md) implements authorization code
with PKCE, short-lived access and rotating refresh tokens. Account-backed
onboarding and the client's exact DCR behavior remain unverified. Do not generalize Team Bot secret
handling to a personal Bot. The
[shared-computer documentation](https://docs.x.ai/grok-bot/computer-and-apps)
also states that all Bots on an account share credentials and browser sessions;
different names or screens are not isolation boundaries.

## Outbound transport boundary

Both adapters use a transport with exact operator-configured HTTPS host
allowlists, no URL credentials or alternate ports, and no redirect following.
Each request resolves DNS, rejects non-public addresses, and pins its connection
to one validated address while retaining the original TLS hostname. IPv4-mapped
IPv6 and transition ranges are rejected. Request bodies are limited to 256 KiB,
responses to 16 KiB, and DNS plus HTTP have one ten-second deadline. Abort signals
prevent a late DNS response from initiating a send after cancellation.

Network failure after a possible send is `uncertain`. A successful HTTP status
never means the Bot replied. The worker determines bounded retries for explicit
transient HTTP failures and honors returned Retry-After values. Provider-side
deduplication remains unknown, so inbox claims and turn completion enforce
idempotency locally.

## Before claiming a working connection

Verify each owner's permission, OAuth connection, actual routine configuration,
the target dot subscription, secure secret registration, authenticated message
consumption, reply completion, and automatic resumption on the original AI.
Run both directions, including a follow-up question, restart, duplicate event,
revoked permission, and stop during pending delivery. Record separately:
notification accepted, inbox claimed, reply committed, and remote task verified.
