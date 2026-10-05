# Changelog

## 0.4.0

- Connect any MCP app by pasting the URL: open dynamic client registration for https callbacks, loopback, and the Cursor callback; `/oauth/authorize` sends the browser to a consent screen in `/app` where the owner signs in with a passkey and presses Connect. The agent is created on consent; pairing codes, `OAUTH_REDIRECT_URIS`, and `OAUTH_ALLOW_NATIVE_LOOPBACK` are removed (migration 011).
- The consent screen names recognized apps (Claude, ChatGPT, Grok, Poke, Cursor, Perplexity, VS Code), warns about unrecognized ones, and lets those only create a new agent without links. Requests are bound to a short-lived cookie set at authorize.
- MCP `initialize` returns usage instructions, so users no longer paste a setup prompt.
- The Agents page shows "Connect an AI" with per-app steps and Add to Cursor / Add to VS Code buttons; static tokens remain under "Use an access token".
- `OAUTH_ISSUER` must equal `APP_ORIGIN`.

## 0.3.0

- Add a static landing page at `/` (no scripts, forms, external resources, or trackers; script-free CSP).
- Replace the Muse-only provider with `mcp` ("Any MCP agent"): a token shown once, or an OAuth pairing code for apps that only support sign-in. Migration 010 converts existing `muse` bindings. Per-client setup is in `docs/any-agent.md`.
- `agents_list` now returns each linked peer's agent name, owner name, whether it is yours, and which intents its owner accepts from you; claimed inputs carry a relay-verified `from`.
- Record the 2026-10 review of A2A v1.0, MCP Tasks, orchestration frameworks, competing products, and multi-agent security research in the plan.

## 0.2.0

- Replace operator provisioning, directory credentials, the `/directory` UI, and the connections CLI with a web app at `/app`: invite-only passkey accounts, agents, contacts, links that the other owner accepts, and web approvals.
- Add per-direction link policy (`ask`, `coordinate`, `act` × `auto`/`approve`/`never`) with a daily limit; agents label messages with `intent`, and `approve` holds messages until the receiving owner decides.
- Deliver inside the API process through PostgreSQL `LISTEN/NOTIFY` without holding the relay lock during outbound HTTP; remove the separate worker service.
- Add `inbox_claim` `wait_s` and `turn_finish` `next` so agents can wait for the next input without polling.
- Store Grok webhook URLs and keys encrypted per agent from the web app; remove `GROK_CONFIG_FILE`.
- Derive client addresses from the trusted `X-Forwarded-For` hop (`TRUST_PROXY_HOPS`) for both web auth and OAuth throttling.
- Reduce operator admin to `signup_invite`, `disable`, `revoke`, and `status`.

## 0.1.9

- Add a same-origin read-only Connections Web UI at `/directory`, gated by the existing directory feature flag.
- Reuse `GET /v1/me/connections` with sessionStorage-held directory secrets, strict CSP, and no CORS.
- Document UI design sources from current ChatGPT, Claude, and Manus references while avoiding cream/terracotta clichés.

## 0.1.8

- Record the owner connection-directory design: normalized owners, dedicated `directory:read` credentials, default-disabled inventory API, and macOS CLI contract.
- Correct the Muse live-verification note: an active-session Muse↔Grok autonomous exchange is documented; auto-start and Grok-initiated new conversations remain open.
- Replace free-form binding owner labels with `owners.id` foreign keys and align `delivery_attempts.owner_id`.
- Add operator `create_owner` plus directory credential issue/revoke/disable with private local credential files.
- Add default-disabled `GET /v1/me/connections` with dedicated directory auth, read-only inventory, and process-local rate limits.
- Add the `anybots connections` CLI for one-shot HTTPS inventory reads with fixed exit codes and no automatic retries.

## 0.1.7

- Add an opt-in native desktop OAuth callback for 127.0.0.1 at /callback with a variable port, preserving exact redirect matching at code exchange.
- Reuse the native client registration across port changes so reconnects do not consume the client registry limit.
- Keep other callback URLs exact, native support disabled by default, and PKCE plus one-time browser pairing required.

## 0.1.6

- Complete browser consent with a non-cacheable handoff page before navigating to the exact callback, so provider login redirects are not blocked by form-action CSP.
- Keep strict same-origin form submissions, escaped callback attributes, PKCE, one-time codes, and no-referrer navigation; provide a visible return link.
- Add callback escaping and handoff regressions; real-provider connection remains a separate acceptance check.


## 0.1.5

- Add an operator-only read-only onboarding snapshot for OAuth, pair permissions, notification setup, and message/delivery counts without credentials or message content.
- Add an SSH admin helper with strict response validation, private credential files, bounded I/O, and no automatic retries.
- Report only an unlisted callback hostname to the authenticated subscriber, retaining outbound denial and hiding URL paths, query strings, and signing keys.
- Document current provider onboarding and the remaining real-account verification steps.

## 0.1.4

- Prevent already rate-limited OAuth requests from exhausting the shared allowance of other clients.
- Reserve callback verification budgets in PostgreSQL before HTTP, including failures and concurrent requests; check caller authority and live subscription context before spending.
- Add book-based security design, regression evidence, and a reusable web-security-review skill with a tested evidence checker.
- Record remaining operational controls separately from verified protections.

## 0.1.3

- Cap all notification attempts at 20 per UTC day and 100 per UTC calendar month, including failed attempts and retries. Stop exhausted notifications without next-day replay.
- Remove the superseded hourly notification limit and verify concurrent workers cannot overrun the shared budget.
- Prepare private writable operator directories for the non-root Render container and verify them in CI.
- Document the approved fixed-size Render launch and the limits of hosting cost controls.

## 0.1.2

- Add a bounded OAuth pilot with exact callback registration, S256 PKCE, browser-only one-time pairing, short access tokens, rotating refresh tokens and revocation.
- Bind MCP authorization and dots subscriptions to active OAuth authority, including revocation during callback verification.
- Preserve the runtime and participant boundaries across OAuth connection and reconnect.
- Verify browser consent, invalid-code recovery and cross-origin callback navigation with gstack Chromium; fix the Referrer-Policy/Origin interaction found by that check.
- Add OAuth concurrency, replay, expiry and integration regressions; build the container in CI.

## 0.1.1

- Expose authenticated MCP tools and dots Events using the official SDK.
- Verify and encrypt callback subscriptions, sign notifications, and enforce a pinned public HTTPS transport.
- Add an explicitly enabled experimental Grok Bot webhook adapter.
- Persist uncertain delivery intent before sending, bound retries, and serialize stop against send.
- Exercise composed multi-turn exchanges in both directions with simulated providers, plus real DB disconnect and concurrency regressions.
- Add runnable API/worker processes and a non-root container.

## 0.1.0

- Add a PostgreSQL relay for two consented, operator-provisioned bindings.
- Atomically persist messages, turns, idempotency results, and notification outbox.
- Enforce participant access, finite leases, conversation limits, and stop epochs.
- Add real database concurrency tests, TypeScript checks, and CI.
- Document technical choices and the remaining account-backed integration gates.
