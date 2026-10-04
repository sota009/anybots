# Connections Web UI

2026-10-04. Read-only screen for limited internal trials.

## Purpose

Operators hand out directory-only credentials. Users open the same-origin page, load their connections and direct contacts, and match connection UUIDs against their registration notes. Same API, DTO, and error codes as the CLI. No message bodies. No AI calls.

## Availability

- Register `/directory` only when `DIRECTORY_ENABLED=true` and `DIRECTORY_AUDIENCE` is set
- Same origin only. No CORS
- When disabled, the route is absent (404)

## Flow

1. Operators give the owner a directory secret and the HTTPS origin
2. The user opens `/directory`
3. They enter the secret and choose **Show connections** (`sessionStorage` only; no persistent cookie)
4. They match displayed connection UUIDs to registration notes
5. **Clear browsing key** removes the secret from `sessionStorage`

Optional: `?connection_id=<uuid>` scopes to one owned connection.

## Screens

1. **Unlock**: Brand **Anybots** as the hero signal, one short English lead, secret field, one primary action
2. **List**: Left rail + main panel. Fetch time, completeness, connection rows with contacts stacked under each
3. **Failure**: Short English guidance mapped to the same fixed API codes. No partial success paint

Primary UI language is **English**. Additional locales come later; do not mix Japanese into the shipped strings until i18n exists.

## Security

- Send `Authorization: Bearer` only. Never put the secret in the URL or query
- Render only allowlisted labels. Ignore unknown response fields
- CSP, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`
- Server audit logs for UI views must not record secrets or response bodies

## Visual direction (imitate ChatGPT + Manus)

Surveyed 2026-10-04:

- **ChatGPT** (Refero Styles; OpenAI Appearance): graphite-on-paper, left rail, hairline borders, achromatic hierarchy, neutral Black accent for primary controls in light mode
- **Manus** (manus.im/brand; Connectors help): white / gray `#F8F8F8` / black `#34322D`, DM Sans, connector-list rows as the product of the screen

Ship:

| Token | Value | Role |
| --- | --- | --- |
| Canvas | `#FFFFFF` / `#F8F8F8` | Main surface / rail |
| Ink | `#0D0D0D` / `#34322D` | Primary text (ChatGPT graphite + Manus black) |
| Muted | `#5D5D5D` | Secondary text |
| Line | `rgba(0,0,0,0.08)` | Hairline only; no heavy shadows |
| Primary CTA | `#0D0D0D` on `#FFFFFF` text | Black button — not green, teal, or blue |
| Font | DM Sans | UI and brand wordmark |

Do not ship teal/green buttons, cool-mist teal washes, Fraunces/Outfit pairing, pill status clusters, or cream+terracotta. Registration state uses weight and muted fill, not green/red chips. Details: [connection-directory.md](connection-directory.md#見た目の根拠2026-10-04調査).
