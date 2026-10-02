# OAuth pilot connection

The relay implements a bounded OAuth authorization server for the first dots and
Grok Bot pilot. It does not verify a real provider connection by itself. A local
OAuth test proves our authorization and token handling; the actual client still
has to complete onboarding and consume a notification from its existing agent.

## Operator configuration

Use the public HTTPS origin, without a path, as the issuer. The protected resource
is exactly that origin followed by `/mcp`. The same issuer is returned in OAuth
authorization responses to prevent authorization-server mix-ups.

```sh
export OAUTH_ISSUER='https://relay.example.com'
export ALLOWED_HOSTS='relay.example.com'
export OAUTH_REDIRECT_URIS='["https://chatgpt.com/connector_platform_oauth_redirect","cursor://anysphere.cursor-mcp/oauth/callback","https://www.cursor.com/agents/mcp/oauth/callback","http://localhost:8787/callback"]'
npm run db:migrate
```

The array is an exact allowlist, with at most four entries. Do not add wildcard
paths or a callback supplied by an untrusted message. Configure only callbacks
needed by the actual client. The three Grok-related entries above come from the
[reported personal-Bot OAuth registration](https://forum.cursor.com/t/grok-bot-custom-mcp-oauth-fails-before-sign-in-redirect-uri-not-allowed/171877).
The `cursor://` entry is an explicit product-compatibility exception to MCP's
HTTPS/localhost redirect guidance; it is not evidence of universal MCP compliance.

[OpenAI's authentication guide](https://developers.openai.com/plugins/build/auth)
permits the stable ChatGPT callback above when the server advertises and returns
issuer identification. This server does both. If the connection management page
shows a callback-specific URL such as `https://chatgpt.com/connector/oauth/{callback_id}`,
replace the ChatGPT entry with that exact URL. Never allow the placeholder or a
prefix match. Choose dynamic client registration in the plugin setup; Client ID
Metadata Documents, OpenID Connect, and enterprise email-domain restrictions are
not implemented in this pilot.

For an explicitly local test only, `OAUTH_ALLOW_HTTP_LOCALHOST=true` permits an
HTTP issuer on localhost or a loopback address. The environment adapter refuses
this exception in production. Keep the existing database configuration and
notification setup from the main README; OAuth does not configure the Grok
routine, enable experimental delivery, or supply a dots callback URL.

## Connect an existing binding

Provision the owner's binding with the existing operator command, then generate
a short-lived pairing code for that binding:

```sh
printf '%s\n' '{"action":"connect","bindingId":"REPLACE_WITH_BINDING_UUID"}' | npm run admin
```

The command returns the path of a mode-0600 file under `.local`, along with its
expiry. The file contains the pairing code; the command's output does not.
Issuing another code for the same binding invalidates the previous one. Codes
expire after ten minutes and can authorize one connection once.

The owner opens the provider's OAuth connection flow for the relay `/mcp` URL,
checks the displayed client, exact callback, and `relay` permission, then enters
the pairing code in the relay's browser form and selects **Connect**. The code
belongs only in that form. Do not paste it, the persistent development bearer,
or OAuth tokens into an AI conversation. The form is the temporary setup-page
exception; normal relay operations stay in the owner's agent.

A pairing code is operator-provisioned identity evidence, not independent login
or account recovery. The operator must establish the owner, intended agent, and
runtime scope before issuing it. OAuth authorization does not create peer grants;
both owners' communication permission still uses the separate operator grant
step. It also does not prove that one dot or Bot is isolated from other agents
sharing the same provider credentials.

## Contract and limits

- Public clients use authorization code with PKCE `S256` and token authentication
  method `none`. Other grant types and client-secret methods are rejected.
- Authorization and token requests must carry the exact `/mcp` resource. The
  single `relay` scope covers this connection's authorized messaging and control
  tools; it grants no access to another binding or unapproved peer.
- Pending consent is bound to the registered client, redirect, resource, scope,
  state, PKCE challenge, a random form token, and an HttpOnly browser cookie. The
  form token expires in ten minutes. Five wrong pairing attempts close that form.
- Successful authorization returns a single-use code valid for two minutes.
  Access tokens last at most fifteen minutes. Refresh credentials rotate on every
  use, with an absolute thirty-day family lifetime. Reuse revokes the family.
- Pairing codes, form/cookie tokens, authorization codes, access tokens, and refresh
  tokens are stored as SHA-256 hashes. Browser pages use no-store, HTML escaping, and a restrictive CSP. The consent
  form uses `Referrer-Policy: same-origin` so Chromium sends a valid Origin on
  the same-origin consent POST while withholding the referrer from external
  callbacks. Other OAuth responses use `no-referrer`. Tokens are not included in relay results.
- Revocation and core relay mutations share the same database ordering lock.
  Token checks include family revocation, scope, resource, expiry, and active
  binding state. Disabling a binding invalidates its OAuth credentials.
- Dynamic registration deduplicates the sorted redirect set. Four configured
  redirects permit at most fifteen nonempty combinations, below the thirty-client
  registry cap. Changing a client label does not allocate a new client.
- Public operations have global and per-address minute limits. Live storage is
  bounded to 100 pairing codes, 256 consent requests, 1,000 token families, and
  50,000 token rows. Expired transient data is removed during OAuth transactions.
  Exhaustion fails closed; this is not a large public identity service.

The module uses the installed SDK's protected-resource metadata helper. The SDK's
server-side authentication API verifies bearer credentials; it is not a complete
authorization-server implementation. Our database-backed code, consent, rotation,
and revocation logic is covered by real PostgreSQL tests.

The [MCP authorization security requirements](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)
require resource audience validation, PKCE support, short-lived credentials, and
refresh rotation for public clients. Live-provider compatibility remains a
separate acceptance test. Grok notification payload behavior is still experimental,
and passing OAuth alone does not prove a reply or autonomous multi-turn exchange.
