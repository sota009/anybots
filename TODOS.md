# Next milestones

## Account-backed dots and Grok exchange

Run both directions with the actual existing agents: notification accepted, inbox claimed, reply committed, original agent resumed. Record timestamps and manual interventions without secrets or unnecessary message content. Requires a public HTTPS endpoint and each owner's consent and account setup. Local integration tests do not close this item.

## OAuth onboarding

Personal Grok Bot currently needs an OAuth connector according to the primary support thread linked in the provider notes. Development bearer credentials alone are insufficient. Implement authorization code + PKCE with explicit redirect policy and protected-resource metadata; prove login and token renewal in each provider. Do not ask owners to paste credentials into an AI conversation.

## Product onboarding and runtime proof

Replace operator provisioning with owner-approved invitations and notification-to-authenticated-reply binding verification. Enforce one active binding per shared authentication runtime until provider identity can distinguish bots. Keep prototype provisioning visibly distinct from completed onboarding.

## Operations before public rollout

Define managed hosting, encrypted backups, retention/deletion jobs, monitoring, and owner recovery/reconciliation for uncertain turns. Add per-binding dispatch isolation after measuring the pilot's global lock contention. Limit the initial pilot to trusted, consented owners. No public signup until these controls have evidence.

## Provider expansion

Add Poke only after the dots/Grok bidirectional text path passes account-backed tests. Add external tool execution scenarios after text exchange; verify actual external state and do not treat an agent's claim as proof of completion.
