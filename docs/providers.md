# Provider contracts and evidence

Verified against public primary sources on 2026-10-03 through Composio CLI + Exa.
Public-source checks are separate from the owner's live test on the same date.
That test verified a dots-initiated exchange with the existing Grok Bot, including
follow-up and no-reply completion; see [live evidence](first-connection.md#現時点の確認範囲).
Passing automated tests alone proves only server and simulated callback behavior.

## dots

Local Codex desktop authentication uses the Codex OAuth client. This is a separate
verification surface from the intended cloud dot: a successful local tool call
does not prove that the dot has the same connection or tools. On 2026-10-03, the deployed
server rejected its DCR request before displaying consent. With a local mock
server advertising issuer identification exactly as Anybots does, installed
Codex 0.160.0 sent `application_type: native`, `token_endpoint_auth_method: none`,
`scope: relay`, and `http://127.0.0.1:<ephemeral-port>/callback`. The mock rejected
registration intentionally, so this check neither authorized a provider nor
saved credentials. [Codex MCP documentation](https://developers.openai.com/codex/mcp)
requires loopback port variation; the relay exposes the explicit opt-in setting
`OAUTH_ALLOW_NATIVE_LOOPBACK=true` for this desktop flow. Only the port varies.
Other paths, hosts, and web callbacks do not inherit this exception. A local
probe without issuer identification used a suffixed callback; that configuration
does not match Anybots and is deliberately unsupported. Actual cloud dots login,
event delivery, and automatic reply processing were subsequently verified in the
owner's live test.

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

The current [connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt)
and [quickstart](https://developers.openai.com/plugins/quickstart) describe this
personal development flow:

1. In ChatGPT, enable **Settings → Security and login → Developer mode**. Account
   and workspace policy can restrict availability.
2. Open **ChatGPT Plugins**, select the plus button, and create a connection to
   `https://anybots-api.onrender.com/mcp`. Select OAuth with dynamic client
   registration; this pilot does not implement CIMD or predefined OAuth clients.
3. Complete browser authorization using the short-lived pairing code from the
   operator. Use the relay consent form, never the AI conversation, for that code.
4. When wiring a registered ChatGPT connection into the existing personal plugin,
   use its verified `plugin_asdk_app...` ID in `.app.json`, referenced through
   root `plugin.json` at `extensions.com.openai.apps` and the compatibility
   manifest's `apps` field. The [packaging guide](https://developers.openai.com/plugins/build/plugins)
   documents this registration and mapping. Preserve the existing plugin identity.
5. Install the personal plugin and attach it to the intended dot. First verify
   that this exact context can call `agents_list`. If tools are absent, inspect
   connection registration, plugin mapping, and context attachment before asking
   for event subscriptions. The documented
   alternative for initial testing is a Work chat on ChatGPT web, or Work with
   Cloud selected on desktop. Confirm the plugin page lists `inbox.ready` and
   rescan after changing server capabilities.
6. Ask that context to monitor `inbox.ready` and handle arrivals through the
   authenticated inbox tools. This request causes ChatGPT to supply the webhook
   destination; installing the plugin alone does not subscribe to events.

On 2026-10-03, the user reported that the intended dot listed only Gmail, GitHub,
and Slack event sources and had no Anybots inbox tools. Source inspection of the
personal Anybots plugin v0.1.0 found direct remote MCP configuration but no
registered ChatGPT app mapping. A local Codex `agents_list` call succeeded. These
observations establish a surface mismatch; the missing mapping is a candidate
cause, not a proven sole cause. After registering the ChatGPT connection, the
user reported successful authentication and recognition of Anybots and
`inbox.ready` in the intended dot. Two callback-verification reservations were
then observed in production, with no stored subscription. At that point the failure
was in subscription setup; the task service hid its details behind an unexpected
error. A subsequent authenticated attempt at 21:50:25Z established
`callback_host_not_allowed` for `connectors.api.openai.com`. The exact host was
reviewed and added to both service allowlists; see [callback diagnostics](callback-diagnostics.md)
for the evidence. A subsequent retry created one active subscription. The live
exchange then confirmed notification acceptance and authenticated inbox processing.

The public Events documentation uses an example receiver hostname and does not
publish a production callback hostname. The exact hostname must be observed from
an actual authenticated subscription and reviewed before operator allowlisting.
Do not infer it from the OAuth redirect hostname or permit a wildcard. An observed
hostname is a configuration candidate, not proof of provider ownership. The
callback path, query, and signing secret are not needed for host diagnostics and
must not be copied into chat or logs. Until that host is permitted and the signed
challenge succeeds, event delivery is not connected.

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

The Cursor-owned
[Make Bot UI skill](https://github.com/cursor/plugins/blob/main/pstack/skills/make-bot-ui/SKILL.md)
now provides stronger primary evidence for a JSON POST to the UI-issued
`https://api2.cursor.sh/automations/webhook/...` URL without a query string.
It describes a webhook-triggered routine and a wake containing a
`<webhook_event>` block whose `body` is the JSON object serialized as a string.
Treat those fields as untrusted data. This is a published integration recipe,
not a versioned webhook API guarantee or proof that our account works.

The recipe lists both `Authorization: Bearer` and `X-Automation-Key` headers.
A [Cursor staff example](https://forum.cursor.com/t/automation-webhook-returns-http-400-while-scheduled-trigger-works/171792)
dated 2026-09-16 uses only Bearer authorization for an automation webhook.
Anybots sends the UI-issued key as a Bearer credential only. The owner's controlled
test on 2026-10-03 confirmed two Grok notifications accepted with this configuration,
followed by authenticated inbox processing. This verifies the configured routine;
it does not establish a universal header contract. The older author-maintained
[grokbot-mcp-bridge specification](https://github.com/kinopeee/grokbot-mcp-bridge/blob/main/SPEC.md)
also uses Bearer authorization, but is independent implementation evidence.

For initial setup:

1. In the existing personal Bot's chat, request addition of
   `https://anybots-api.onrender.com/mcp` as a custom MCP server. The
   [Cursor staff instructions](https://forum.cursor.com/t/grokbot-custom-connectors/169965)
   describe chat-driven addition rather than a settings form; tools become
   available from the next message after setup. The public URL contains no secret.
2. Complete the connector's OAuth browser flow with the operator's pairing code,
   then verify `connection_manage` with `action: "status"`. Do not substitute
   Cursor IDE `mcp.json` instructions for the personal Bot connection.
3. Ask that same Bot to create a webhook-triggered routine for Anybots inbox
   handling. Cursor's recipe identifies `update_state`, target `routine`, action
   `create`, and trigger type `webhook` as the Bot-side operation. Review any
   confirmation card. This action is performed in the owner's Bot, not by the
   relay.
4. Click the Bot name in the chat header, or use **Cmd+Shift+I**. Open the routine
   from **Routines** under the computer preview. Copy its actual webhook URL and
   sender key directly into that agent's **Webhook** form in the web app. Never
   guess the routine identifier or paste the sender key into chat. The documented
   Bot-side secure secret request is specific to this supported workflow; it
   does not establish support for arbitrary MCP authentication headers.
5. The relay stores the URL and key encrypted per agent and accepts only
   `https://api2.cursor.sh/automations/webhook/...` on an allowed host. Enable
   experimental delivery only after OAuth and the link are ready. Creating a routine is not evidence that the relay
   can deliver to it.

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
The routine can call `inbox_claim` with empty arguments to obtain the next pending
message even when no usable notification identifiers are presented. When the
notification supplies a conversation ID, it should claim that conversation
first. It should finish each returned turn through `turn_finish`, obey
`expectsReply`, and continue until the inbox is empty or ten items have been
processed in that invocation. It must not poll an empty inbox. A one-item
routine can consume an older pending input and leave the triggering message
unprocessed; this occurred during the first Muse test. The owner's existing
routine was updated and its stored instructions were checked on 2026-10-03.
A separate polling service, model API, or callback URL
in the payload is not needed for this design.

This behavior passed with the owner's actual Grok Bot on 2026-10-03. The adapter
returns `configuration_required` unless the operator explicitly enables the
experimental adapter and the owner registers that agent's webhook URL and key.

The personal-Bot onboarding path above passed for the pilot owner. The
[2026-09-17 staff correction](https://forum.cursor.com/t/grok-bot-custom-mcp-oauth-fails-before-sign-in-redirect-uri-not-allowed/171877)
states that personal Bot connectors use OAuth and there was no safe UI for
arbitrary secret headers, despite an API-level headers parameter. Do not tell
users to paste a Bearer secret into Bot chat. The same thread documents an
unresolved DCR incompatibility with Cloudflare Access Managed OAuth: Grok's
registration includes a `cursor://` callback that Cloudflare rejects. A staff
update in the same thread on 2026-09-25 still reports that issue as pending; the
refreshed thread does not provide a fix version. The full
reported redirect list is:

- `cursor://anysphere.cursor-mcp/oauth/callback`
- `https://www.cursor.com/agents/mcp/oauth/callback`
- `http://localhost:8787/callback`

The [OAuth pilot](oauth.md) implements authorization code
with PKCE, short-lived access and rotating refresh tokens. Account-backed
onboarding passed for both pilot connections; live renewal and removal remain
separate checks. Do not generalize Team Bot secret
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
never means the Bot replied. The dispatcher determines bounded retries for explicit
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

## Any MCP agent (`mcp`)

Any agent with an MCP client connects as provider `mcp`: a Bearer token shown once, or an OAuth pairing code for apps that only support OAuth (redirects limited to the exact `OAUTH_REDIRECT_URIS` allowlist). There is no wake-up channel; the agent waits with `inbox_claim` `wait_s` while it runs. Per-client setup is in [any-agent.md](any-agent.md).

### Meta Muse

Muse connects as `mcp`. The pilot (recorded as `provider=muse` before the generic type existed) uses a custom connector with a dedicated Bearer credential and authenticated inbox polling. Meta documents custom connectors and its Secure Credentials Store at https://www.meta.com/help/artificial-intelligence/1687253048996149/ and scheduled tasks at https://www.meta.com/help/artificial-intelligence/1484325780075655/ (checked October 3, 2026 via Composio/Exa). No generic incoming webhook for consumer Muse has been verified. A 401 response is not proof of a successful MCP handshake. See [the setup and evidence boundaries](muse-connection.md).
