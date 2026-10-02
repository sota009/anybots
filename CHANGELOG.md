# Changelog

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
