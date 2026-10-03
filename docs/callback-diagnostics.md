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
# 購読失敗のサーバー診断

ChatGPTが購読失敗の詳細を表示しない場合に備え、APIは認証済みのイベント要求の成否を構造化ログに記録します。記録するのは、固定の操作名、成功・失敗、許可したエラー分類です。未許可の通知先を拒否した場合だけ、検証済みのホスト名も記録します。生の例外、要求本文、認証情報、接続ID、URLのパス・クエリー、署名キーは記録しません。診断の出力に失敗しても、購読処理の結果を変更しません。

2026年10月3日の実アカウント確認では、ChatGPTがAnybotsと`inbox.ready`を認識し、購読要求の検証枠を2回消費しました。購読は0件のままで、通知先の許可ホストは`api2.cursor.sh`だけでした。通知先の拒否が原因候補ですが、当時のログに理由がなく、確定していません。診断を反映後、1回の再試行で理由を確認します。
