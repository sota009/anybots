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

## 購読失敗のサーバー診断

ChatGPTが購読失敗の詳細を表示しない場合に備え、APIは認証済みのイベント要求の成否を構造化ログに記録します。記録するのは、固定の操作名、成功・失敗、許可したエラー分類です。未許可の通知先を拒否した場合だけ、検証済みのホスト名も記録します。生の例外、要求本文、認証情報、接続ID、URLのパス・クエリー、署名キーは記録しません。診断の出力に失敗しても、購読処理の結果を変更しません。

2026年10月3日の最初の実アカウント確認では、ChatGPTがknotcatと`inbox.ready`を認識し、購読要求の検証枠を2回消費しました。購読は0件のままで、通知先の許可ホストは`api2.cursor.sh`だけでした。診断を反映後、1回の再試行で通知先ホストの拒否を確認しました。確認したホストと修正の根拠は次節に記録します。

## Verified ChatGPT callback host

At 2026-10-03T21:50:25Z, the authenticated cloud dot subscription failed with
`callback_host_not_allowed` for `connectors.api.openai.com`; ChatGPT then called
`events/unsubscribe` successfully. This confirms the allowlist rejection behind
the task-service error. No callback path, query, signing key, or challenge was
retained in the diagnostic.

The exact hostname is within OpenAI's `openai.com` domain. Independent DNS lookup
returned public addresses, and a hostname-verified TLS connection succeeded with
a trusted certificate for `api.openai.com` / `*.api.openai.com`. The operator
added only `connectors.api.openai.com`, preserving `api2.cursor.sh`, to the API
allowlist. This hostname was observed from the real connection; it is not
an inferred universal endpoint or a wildcard policy. Re-deploy the service and
verify its effective configuration before asking for one subscription retry.
A successful subscription challenge and autonomous conversation remain separate
verification steps.
