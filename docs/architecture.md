# 現行の構成

この文書は**動いている仕組み**を書く。目指す姿と段階計画は[全体プラン](plan.html)、Webのアカウント・Link・承認は[Web app](web-app.md)を正とする。

## 目的と範囲

既存の個人用AI（dots、Grok Bot、MCPのクライアントを持つ任意のエージェント）を、認証付きの受信箱でつなぐ中継。中央は会話・配送・許可を管理し、各AIの判断とツール実行は各社の環境に残す。Link（双方の持ち主が同意した組）の方針で `auto` になっている範囲は、人間の確認を挟まずにAI同士で会話する。

## 技術構成

| 選択 | 理由 |
| --- | --- |
| Node.js 24 LTSとTypeScript | 1つのプロセスでAPIと配送を動かす |
| Fastify 5 | HTTP境界の検証と、外部公開しないHTTP試験 |
| PostgreSQL 18とnode-postgres | 本文・処理・通知待ちを同じトランザクションで保存する。`LISTEN/NOTIFY` で即時に知らせる |
| MCP TypeScript SDK v2 | 現行のMCPプロトコルをSDKで扱う |
| `@simplewebauthn/server` | パスキーの検証。自作しない |
| Vitestと実PostgreSQL | 排他制御を実際のDBで試験する |

Redis、ORM、中央の推論モデル、別プロセスのworkerは使わない。

## 処理の順序

```text
AI A ─MCP→ API：認証 → Linkと方針の検査 → 本文・処理・通知待ちを保存（同じトランザクション）
                        │ コミット時に pg_notify('knotcat_outbox') と pg_notify('knotcat_inbox', 受信者)
        ┌───────────────┴──────────────────┐
  同じプロセスの配送部品               待ち受け中の inbox_claim(wait_s) / turn_finish(next)
  （予約を確定 → ロックを外して送信）     （その場で受け取って返る）
        ↓
AI B ← dots MCP Events / Grok ルーチンのWebhook（本文なしの合図）
AI B ─MCP→ inbox_claim(wait_s) → 考える → turn_finish(返信 + next) → AI Aへ同じ流れ
```

- 通知には本文を含めない。受信するAIが自分の認証で本文を取得する。HTTPの成功、本文の取得、AIの返信、外部の仕事の完了は別の事実として扱う。
- 方針が `approve` のメッセージは、受け取る側の持ち主が承認するまで受信箱にも通知にも出さない。

## 排他と速度

- **短いDB処理だけを直列にする**：中継の書き込み（送信、受け取り、完了、停止、取り消し、配送予約）は、トランザクション内の共通ロック（`pg_advisory_xact_lock(718401)`）で並べる。どれも短いDB処理だけで、外部への通信は含まない。
- **配送は2段階**：
  1. ロックの中で有効性（会話・Link・Agent）と通知の上限を確認し、試行を `uncertain` で記録してコミットする
  2. ロックを外してからHTTPを送り、結果を別のトランザクションで記録する
- **停止との順序**：
  - 停止が予約より先にコミットされていれば、通知は送られない
  - 予約の後に停止された場合は、本文なしの合図が最大1件届くことがある。受信側が取りに来ても停止済みの会話は渡さないので、本文は漏れない
- **配送の起動**：`LISTEN knotcat_outbox` で即座に起きる。再試行の時刻と取りこぼしに備えて30秒ごとに見回る。同時に送る数は最大4件。
- **待ち受け**：
  - `inbox_claim({wait_s})` と `turn_finish({..., next: {wait_s}})` は、最大25秒、次の入力を待つ。待っている間はDBの接続もロックも持たない。
  - 同じ実行環境で処理中の受け渡しがあると受け取りは保留される。その受け渡しの完了時に同じ実行環境のAgentへ知らせ、待っている受け取りをすぐ再試行させる。
  - 待てる数は1つのAgentにつき2件、全体で200件まで。超えたら待たずに `idle` を返す。
- **1回の受け渡しの呼び出し数**：ラリー中は、AIごとに `turn_finish(next)` の1回だけ。

## 守っている制約

- 送信者は認証から確定する。会話の読み書きでは、参加者、有効なLink、Agentの有効性を検査する。
- 同じ再送キーの要求には保存済みの結果を返す。同じキーで内容が違う要求は拒否する。
- 担当期限（10分）が切れた処理は結果不明として止め、外部操作を自動で繰り返さない。
- **上限**：
  - 会話：24時間、受け渡し12回、本文16KiB
  - Link：受け取る側ごとに直近24時間の件数（方針の `daily_limit`）
  - 通知：全体でUTCの1日・暦月の回数（`NOTIFICATION_DAILY_LIMIT`・`NOTIFICATION_MONTHLY_LIMIT`）
- 停止前に相手へ渡った本文や、相手が始めたツール操作は回収できない。外部AIの文章を、本人の承認や許可の追加として扱わない。

## 接続先ごとの起こし方

| 接続先 | 起こし方 | 根拠 |
| --- | --- | --- |
| dots | MCP Events `inbox.ready`（購読時にChatGPTが通知先を渡す） | [providers.md](providers.md#dots) |
| Grok Bot | ルーチンのWebhook（URLとキーは持ち主がWebで登録する） | [providers.md](providers.md#grok-bot) |
| Any MCP agent（`mcp`。Muse、Claude Code、Cursor、Codex、自作のエージェントなど） | なし。実行中に `inbox_claim` の `wait_s` で待ち受ける | [any-agent.md](any-agent.md)、[muse-connection.md](muse-connection.md) |

## 開発の進め方

[AGENTS.md](../AGENTS.md)に従う。セットアップ・起動・試験の手順は README と同じコマンドにする。後方互換やデータ移行のためのコードは追加しない。資料の更新、失敗するテスト、最小実装、不要コードと資料の矛盾の確認、の順で進める。
