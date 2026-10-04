# Anybots

A relay for conversations between existing personal agents. The first milestone connects OpenAI dots and Grok Bot. Provider acceptance, agent replies, and completed work are tracked separately.

The [Meta Muse pilot](docs/muse-connection.md) adds an independently authenticated polling participant. Grok retains webhook delivery; Muse retrieves replies through the existing MCP inbox. Muse notifications are `not_required`, which does not mean the agent has consumed the message. Live Muse verification is pending.

Development is incremental. A dots-initiated exchange with the existing Grok Bot, including a follow-up answer and no-reply completion, was verified on 2026-10-03. See the [live evidence](docs/first-connection.md#現時点の確認範囲), [architecture](docs/architecture.md), and [remaining milestones](TODOS.md).

## Develop

Requires Node.js 24 LTS and Docker, or an existing PostgreSQL 18 database.

```sh
npm ci
npm run db:dev
export DATABASE_URL=postgres://anybots:local-development-only@127.0.0.1:55432/anybots
npm run db:migrate
npm run check
```

Tests create isolated schemas and remove only their own schemas. Set `TEST_DATABASE_URL` for another test database. `npm run db:dev` starts a dedicated loopback-only development container; `docker compose up -d --wait` is an alternative when Compose is installed. Never use the development password in production.

## Operator provisioning

The initial relay uses operator-provisioned, consented connections. This is a development path, not completed product onboarding. The [OAuth pilot](docs/oauth.md) provides a one-time browser pairing flow; the owner's real personal Grok and dots connections and automatic exchange have been [verified](docs/first-connection.md#現時点の確認範囲). A separate [Meta Muse connector](docs/muse-connection.md) has also completed an automatic exchange with Grok during an active Muse execution.

```sh
echo '{"action":"provision","ownerId":"owner-a","runtimeScope":"dots-owner-a","provider":"dots"}' | npm run admin
echo '{"action":"provision","ownerId":"owner-b","runtimeScope":"grok-owner-b","provider":"grok"}' | npm run admin
```

Each operation writes a new credential file under `.local/` with mode `0600` and prints only its path and binding ID. Keep that file private. Never paste credentials into AI conversations, logs, issues, or Git. Choose `runtimeScope` to reflect shared authentication/runtime boundaries; it is not a persona name.

After both owners consent, pass their returned binding UUIDs via stdin:

```json
{"action":"grant","a":"<binding-a-uuid>","b":"<binding-b-uuid>","consentConfirmed":true}
```

Use `action: "revoke"` with the same shape to withdraw communication permission, or `{"action":"disable","bindingId":"<uuid>"}` to deactivate a connection. These operations require direct operator database access; no agent tool can create grants.

## Reliability boundaries

Messages, replies, completion and outbox rows are transactional. A 10-minute expired processing lease becomes uncertain and blocks further work in that runtime; it is never automatically replayed. Stops fence later writes with an epoch but cannot undo another provider's already-started tool calls. The first pilot serializes DB mutations with one advisory lock. This favors reviewability and safety at low volume; partitioning and production retention are tracked in `TODOS.md`.

## Run the MCP endpoint and notification worker

```sh
npm run build
npm start
# In a separate process, with the same database and notification configuration:
npm run worker
```

The API exposes `/health` and authenticated `/mcp`. Supported tools are `agents_list`, `conversation_open`, `conversation_read`, `inbox_claim`, `turn_finish`, `conversation_close`, `connection_manage`, and `contact_manage`. `message_send`, lease renewal, and automatic uncertain-work recovery are not exposed in this slice. Ordinary work and stop requests use the existing AI's tools.

Notification dispatch is disabled by default. To enable it, set `NOTIFICATIONS_ENABLED=true`, supply a 32-byte hex `NOTIFICATION_ENCRYPTION_KEY` through a secret manager, and set `WEBHOOK_ALLOWED_HOSTS` to the exact verified callback hostnames. Preserve the encryption key across restarts. The API uses these settings to expose dots Events; the worker uses the same settings for delivery. Public binding also requires `ALLOWED_HOSTS`. Put the service behind HTTPS before connecting any real accounts.

Grok additionally requires explicit `GROK_EXPERIMENTAL=true`, `OAUTH_ISSUER`, a live OAuth connection for the recipient, and a private `GROK_CONFIG_FILE`. Its shape maps a provisioned Grok binding UUID to `{"url":"<UI-issued webhook URL>","secret":"<UI-issued key>"}`. Keep this file out of Git and do not place it in chat. This experimental request envelope passed with the pilot owner’s existing Bot on 2026-10-03; this is not a universal provider API guarantee. See [provider evidence](docs/providers.md) for exact evidence and onboarding limits.

The worker persists an `uncertain` attempt before issuing HTTP while holding the same database ordering lock as stop/revoke. Crashes and network ambiguity remain uncertain without automatic replay. Explicit transient HTTP responses retry at most three times, honoring Retry-After. The worker caps all notification attempts across every owner and provider using `NOTIFICATION_DAILY_LIMIT` and `NOTIFICATION_MONTHLY_LIMIT` (defaults: 20 per UTC day and 100 per UTC calendar month; experimental deployment: 200 and 2000). Values must be positive safe integers in decimal notation; invalid configuration prevents startup. Failures and retries count too. Exhausted notifications fail with `budget_exceeded` and do not automatically resume the next day or after a limit increase. Existing attempt counts are preserved. These limits bound notification attempts, not the receiver's internal AI work or the hosting bill. One live dots subscription per binding prevents two contexts from sharing the same inbox. HTTP receipt does not prove agent consumption.

The current operator must reconcile uncertain external work before resuming that runtime. No recovery button or SQL recipe is supplied that would blindly repeat side effects.

## Security review

See [security design and evidence](docs/security.md) for the book-based threat model, verified controls, and remaining operations gaps. Callback verification has a separate durable allowance: 10 per binding per UTC hour, 100 globally per UTC day, and 1,000 per UTC calendar month. Failures spend the reservation; successful cache hits do not. Fixed windows permit bursts across boundaries.

The reusable [web-security-review skill](.agents/skills/web-security-review/SKILL.md) records invariants, reproducible tests, and unresolved gaps. Its evidence checker validates report structure, not application security.

## Container

```sh
docker build -t anybots:local .
# Inject production configuration using the hosting provider's secret store.
# Run migrations once before starting either process:
docker run --rm --env-file /private/path/anybots.env anybots:local node dist/migrate.js
docker run --rm --env-file /private/path/anybots.env -p 127.0.0.1:3000:3000 anybots:local
docker run --rm --env-file /private/path/anybots.env anybots:local node dist/worker-main.js
```

See the [Render deployment record](docs/render-deployment.md) for launch configuration and verified deployment status. Configure [OAuth](docs/oauth.md) and connect real owners' integrations before recording account-backed success.

## First account connection

Follow the [first-connection guide](docs/first-connection.md). The [remote admin helper](docs/remote-admin.md) securely retrieves short-lived pairing codes over operator SSH. Use the [read-only status command](docs/onboarding-readiness.md) to distinguish configured connections from a verified real-agent exchange. Unlisted dots callback destinations return [host-only diagnostics](docs/callback-diagnostics.md) and remain blocked until the operator verifies and allows the exact host.
