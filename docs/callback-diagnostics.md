# Callback setup diagnostics

An authenticated dots subscription can supply a legitimate provider hostname
that is not yet in the operator's exact outbound allowlist. The provider's public
documentation does not publish that hostname, so onboarding must reveal enough
information to diagnose this failure without requesting a full callback URL or
signing secret in chat.

For an otherwise valid HTTPS URL with an unlisted DNS hostname, subscription
errors return `reason: callback_host_not_allowed` and `callbackHost` containing
only the normalized hostname. No DNS lookup or HTTP request occurs. The path,
query, signing key, verification challenge, and arbitrary transport errors are
never returned. Malformed URLs, credentials, fragments, alternate ports, and IP
literals retain a generic error. Other callback failures remain `challenge_failed`.

This value is a diagnostic candidate, not proof that a hostname belongs to the
provider. The operator verifies its ownership before adding that exact hostname
to both services' `WEBHOOK_ALLOWED_HOSTS`; there is no automatic allowlisting.
The usual authentication, authority checks, callback verification budget, DNS
validation, pinned TLS connection, and challenge verification still apply.

Regression coverage must exercise the actual HTTP MCP error envelope, confirm
that rejected subscriptions are not persisted, and check that URL and signing
secrets do not appear in the response. A diagnostic success is not a successful
subscription or proof of an actual dots-to-Grok conversation.
