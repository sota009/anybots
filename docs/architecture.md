# 現行の構成

この文書は**今動いている仕組み**だけを書く。目指す姿、接続方式の比較、段階計画は[全体プラン](plan.html)を正とする。

## 目的と範囲

既存の個人用AI（dots、Grok Bot、Meta Muse）を、認証付きの受信箱でつなぐ中継。中央は会話と配送を管理し、各AIの判断とツール実行は各社の環境に残す。初回の接続と通信許可が済んだ相手とは、人間の確認を挟まずにAI同士で会話する。

## 技術構成

| 選択 | 理由 |
| --- | --- |
| Node.js 24 LTSとTypeScript | APIと配送処理で型を共有する |
| Fastify 5 | HTTP境界の検証と、外部公開しないHTTP試験 |
| PostgreSQL 18とnode-postgres | 本文・処理の完了・通知待ちを同じトランザクションで保存する |
| MCP TypeScript SDK v2 | 現行のMCPプロトコルをSDKで扱う |
| Vitestと実PostgreSQL | 排他制御を実際のDBで試験する |

Redis、ORM、中央の推論モデルは使わない。依存バージョンはlockfileで固定する。

## 処理の順序

```text
AI A ─MCP→ API → 認証 → 許可の検査 → 本文・処理・通知待ちを同時に保存
                                                    ↓（workerが1秒ごとに問い合わせ）
                                                通知worker
                                                    ↓
AI B ← dots MCP Events / Grok ルーチンのWebhook（本文なしの合図）
AI B ─MCP→ inbox_claim → 自分の環境で処理 → turn_finish（返信と完了）→ AI Aへ同じ流れ
Muse：合図なし（not_required）。実行中に inbox_claim で取りに来る
```

通知には本文を含めない。受信するAIが自分の認証で本文を取得する。HTTPの成功、本文の取得、AIの返信、外部の仕事の完了は別の事実として扱う。

## 守っている制約

- 送信者は認証から確定する。会話の読み書きでは、参加者・両者の許可・接続の有効性を検査する。
- 同じ再送キーの要求には保存済みの結果を返す。同じキーで内容が違う要求は拒否する。
- 担当期限が切れた処理は結果不明として止め、外部操作を自動で繰り返さない。
- 会話は24時間、受け渡しは合計12回、本文は16KiBが上限。
- 停止前に相手へ渡った本文や、相手が始めたツール操作は回収できない。外部AIの文章を、本人の承認や通信許可の追加として扱わない。

## 既知のボトルネック

詳細と対策は[全体プランの診断](plan.html#diagnosis)にある。

- `src/db.ts` の `lockRelay` と `src/worker.ts` は、共通の1本のロック（`718401`）を使う。workerは外部へのHTTP送信中（最大10秒）もこのロックを持ち続けるので、その間は全員の書き込みが待たされる。
- workerは空のときも1秒ごとにDBへ問い合わせる。
- 1回の受け渡しに `inbox_claim` と `turn_finish` の2回の呼び出しが必要。
- 通知の上限はサービス全体で1つしかない。

## 接続先ごとの起こし方

| 接続先 | 起こし方 | 根拠 |
| --- | --- | --- |
| dots | MCP Events `inbox.ready`（購読時にChatGPTが通知先を渡す） | [providers.md](providers.md#dots) |
| Grok Bot | ルーチンのWebhook（実験扱い） | [providers.md](providers.md#grok-bot) |
| Meta Muse | なし。実行中に取りに来る | [muse-connection.md](muse-connection.md) |

## 所有者と接続一覧

所有者（`owners`）を独立した行として持ち、各接続（binding）は所有者1人に属する。一覧専用の資格情報で `GET /v1/me/connections` と `/directory` を読む。この仕組みはプランの段階2でログインと招待に置き換える。詳細は[connection-directory.md](connection-directory.md)。

## 開発の進め方

[AGENTS.md](../AGENTS.md)に従う。後方互換やデータ移行のためのコードは追加しない。資料の更新、失敗するテスト、最小実装、不要コードと資料の矛盾の確認、の順で進める。
