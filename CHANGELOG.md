# Changelog

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
