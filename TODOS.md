# Next milestones

## Owner connection directory

Design is in [connection-directory.md](docs/connection-directory.md); CLI handoff is in [connection-directory-cli.md](docs/connection-directory-cli.md). Local P1–P3 implementation is in progress/merged as stacked slices with the directory route default-disabled. Do not treat merges as product onboarding. Remaining acceptance: isolated-environment enablement and a real owner's first `anybots connections` run, plus revoke/reissue recovery.

## Account-backed dots and Grok exchange

On 2026-10-03, a dots-initiated exchange passed with the existing agents: three notifications accepted on their first attempts, three inbox turns finished, and the final input consumed as `no_reply`. The user reported completion without intervening during the exchange; production DB records independently confirm the processing. See [timestamps and evidence boundaries](docs/first-connection.md#現時点の確認範囲). Still verify a Grok-initiated new conversation and live restart, duplicate-event, revocation, and stop scenarios. Local tests do not close those remaining items.

## Operator provisioning and pairing

Live Render SSH authentication and the deployed admin `status` command were confirmed on 2026-10-03 with v0.1.5 (`725e36f`). The command read DB state and loaded OAuth and notification configuration. Both pilot bindings and their pair grant are provisioned. Official SDK requests authenticated with operator credentials confirmed that each binding lists only its intended peer. Issue private browser pairing codes immediately before account setup. Both actual provider OAuth connections and the dots-initiated autonomous exchange have now passed.

## Verify OAuth onboarding with real providers

Authorization code + PKCE, one-time browser pairing, resource metadata, refresh rotation and revocation are implemented and tested locally. Both real provider logins succeeded with public DCR and token auth method `none`. Still verify live token renewal, target-agent identity isolation, and connector removal in each provider; other token auth methods remain intentionally unsupported. Never ask owners to paste credentials into an AI conversation.

## Product onboarding and runtime proof

Replace operator provisioning with owner-approved invitations and notification-to-authenticated-reply binding verification. Enforce one active binding per shared authentication runtime until provider identity can distinguish bots. Keep prototype provisioning visibly distinct from completed onboarding.

## Operations before public rollout

Managed fixed-size Render hosting is live. Before expanding beyond trusted pilot owners, verify encrypted-backup restoration, separate runtime DB permissions from schema administration, define retention/deletion jobs and privacy-safe security monitoring, and document owner recovery/reconciliation for uncertain turns. Bound DB connection/lock/statement waits with contention tests and add controlled DNS/socket tests for transport behavior. Add per-binding dispatch isolation after measuring the pilot's global lock contention. Limit the initial pilot to trusted, consented owners. No public signup until these controls have evidence.

## Provider expansion

Add Poke only after the dots/Grok bidirectional text path passes account-backed tests. Add external tool execution scenarios after text exchange; verify actual external state and do not treat an agent's claim as proof of completion.
