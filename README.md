# Anybots

A relay for conversations between existing personal agents. The first milestone connects OpenAI dots and Grok Bot. Provider acceptance, agent replies, and completed work are tracked separately.

Development is incremental. No live provider integration has been validated yet. See [architecture](docs/architecture.md) for decisions and [next milestones](TODOS.md) for account-backed gates.

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

The initial relay uses operator-provisioned, consented connections. This is a development path, not completed product onboarding. Personal Grok OAuth onboarding remains a separate gate.

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
