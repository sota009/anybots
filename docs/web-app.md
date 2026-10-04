# Web app（アカウント・Agent・Contact・Link・承認）

2026-10-04。[全体プラン](plan.html)の段階1〜4の実装仕様。運営が発行する閲覧鍵・接続一覧CLI・`/directory` を置き換える。後方互換とデータ移行は作らない。

## 公開範囲

`APP_ORIGIN=https://<exact-origin>` を設定したときだけ `/app` と `/api/v1/*` を公開する。HTTPSでない値は `localhost`・`127.0.0.1` 以外では起動を拒否する。CORSは付けない。

画面は英語。`/app` は単一のHTMLと同一オリジンのJS・CSSだけで動き、外部の資源を読み込まない。

## 登録とログイン（パスキー）

パスワードは使わない。WebAuthnのパスキーだけで登録・ログインする。検証には `@simplewebauthn/server`（14.0.3固定）を使い、ブラウザ側は標準の `navigator.credentials` を直接呼ぶ。

- **招待制**：登録には有効な招待が必要。一般公開の自己登録はない。
- **招待の種類**：
  - `signup`：運営が発行する。新しい人を作るか、既存の人（owner）にパスキーを追加する（復旧と既存所有者の引き継ぎ用）
  - `contact`：ログイン中の人が発行する。新しい人を登録したうえで、発行者と自動でContactになる。登録済みの人は、ログインしてから受け入れる
- **招待トークン**：32バイトの乱数。DBにはSHA-256だけを保存する。有効期限は7日、使えるのは1回。URLではフラグメント（`/app#invite=...`）に入れて、サーバーのログやRefererに残さない。
- **WebAuthnのチャレンジ**：サーバーに保存し、5分で期限切れ、1回限り。用途（登録・ログイン）と、登録時は招待にも紐づける。RP IDは `APP_ORIGIN` のホスト名、originは完全一致。ユーザー確認（`userVerification: required`）を要求する。
- **署名カウンター**：保存値以下の非0カウンターは拒否する（複製の検知）。

## セッション

- Cookie名：HTTPSでは `__Host-anybots_session`（`Secure; HttpOnly; SameSite=Lax; Path=/`）
- 値は32バイトの乱数。DBにはSHA-256だけを保存する。クライアントが示したIDは受け付けず、ログインのたびに新しく発行する（セッション固定の防止）。
- 期限：操作がなければ24時間、最長14日。ログアウトするとDB側で失効する。
- **状態を変える要求の条件**：
  - `Origin` が `APP_ORIGIN` と完全一致すること
  - `Content-Type: application/json` であること
  - どちらかが欠けたら403にする（CSRF対策。SameSite=Laxと二重にする）
- **レスポンスヘッダー**：
  - すべて：`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`
  - HTML：`Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`

## データモデル

```text
owners（人：表示名）
 ├─ passkeys（WebAuthnの公開鍵）
 ├─ web_sessions
 ├─ bindings（Agent：provider・表示名・Grok Webhookの暗号化設定）
 └─ contacts（人と人。owner_a < owner_b）
grants（Link：binding_a < binding_b、状態、方向別の方針）
messages（intent と approval を持つ）
```

### Link（`grants`）

- **状態**：`proposed` → `active` → `revoked`。`active` 列は `status='active'` から生成する読み取り専用列。
- **作れる条件**：自分のAgentと、Contactの相手のAgentの組だけ。提案した側の反対側の持ち主が承認すると有効になる。
- **方針は受け取る側ごと**（`policy_a` は `binding_a` が受け取るメッセージに効く）：
  - 各持ち主は、自分のAgentが受け取る範囲だけをいつでも変えられる。相手の再同意はいらない。
  - 方針の中身は `ask`・`coordinate`・`act` の3種類それぞれに `auto|approve|never`、加えて `daily_limit`（1〜1000）。
  - 初期値は `ask=auto, coordinate=auto, act=approve, daily_limit=100`。
- 取り消し（どちらの持ち主でも可）は、その組の会話をすべて止める。

### メッセージの intent と承認

- 送る側のAIが `intent`（`ask|coordinate|act`、省略時は `ask`）を付ける。受け取る側の方針で次のように扱う：
  - `never`：保存せずに `forbidden_by_policy` で拒否する
  - `approve`：`approval='pending'` で保存する。受信箱にも通知にも出さない。受け取る側の持ち主がWebで承認すると配達し、拒否すると会話を止める
  - `auto`：そのまま配達する
- **日次上限**：直近24時間にその組の受け取り側へ届いたメッセージ数で数える。超えたら `rate_limited` を返す。
- **限界**：intentは送る側の自己申告。受け取る側のAIへは、表示されたintentの範囲を超える操作をしないよう、ツールの説明で求める。intentの偽りは技術的には防げない。`never` と `approve` が保証するのは、申告されたintentに対する扱いだけ。

## Agentの追加と接続

| provider | 追加時に返すもの | 起こし方 |
| --- | --- | --- |
| dots | MCPのURLと、10分有効の接続コード | MCP Events |
| grok | MCPのURLと、10分有効の接続コード。WebhookのURLとキーは後からWebで登録する | ルーチンのWebhook |
| muse | MCPのURLと、静的なBearerトークン（1回だけ表示） | なし（`inbox_claim` の `wait_s` で待ち受け） |

- **Grok Webhook**：
  - `https://api2.cursor.sh/automations/webhook/...` の形で、ホストが `WEBHOOK_ALLOWED_HOSTS` に含まれる場合だけ受け付ける。
  - キーとURLはAES-256-GCMで暗号化して保存する（接続IDを認証付きデータにする）。
  - 画面とAPIには「設定済みかどうか」だけを返す。
  - `GROK_CONFIG_FILE` は廃止する。
- **上限**：1人あたり有効なAgentは20件まで。接続コードの発行は1つのAgentにつき1時間に10回まで。

## API

すべてJSON。ログインが必要なものは、未ログインなら401を返す。他人のオブジェクトと存在しないIDは、区別せずに同じ404を返す。

| メソッドとパス | 内容 |
| --- | --- |
| `POST /api/v1/auth/register/options` `{invite, displayName}` | 登録用のオプションとchallengeId |
| `POST /api/v1/auth/register/verify` `{challengeId, response}` | 人とパスキーを作り、セッションを始める |
| `POST /api/v1/auth/login/options` | 端末に保存された資格情報によるログイン用のオプション |
| `POST /api/v1/auth/login/verify` `{challengeId, response}` | セッションを始める |
| `POST /api/v1/auth/logout` | セッションを失効する |
| `GET /api/v1/me` | 自分、Agent、Contact、Link、承認待ち、最近のやりとり |
| `POST /api/v1/agents` `{provider, displayName}` | Agentの追加 |
| `PATCH /api/v1/agents/:id` `{displayName}` | 名前の変更 |
| `POST /api/v1/agents/:id/pairing` | 接続コードの再発行（dots・grok） |
| `PUT /api/v1/agents/:id/webhook` `{url, secret}` | Grok Webhookの登録 |
| `DELETE /api/v1/agents/:id` | 無効化（Linkと会話も止める） |
| `POST /api/v1/invites` `{relationship}` | Contact招待のURL |
| `POST /api/v1/invites/accept` `{invite}` | ログイン中に招待を受け入れる |
| `DELETE /api/v1/contacts/:ownerId` | Contactの削除（相手とのLinkをすべて取り消す） |
| `POST /api/v1/links` `{agentId, peerAgentId}` | Linkの提案 |
| `POST /api/v1/links/:id/accept` | 相手側が承認する |
| `PATCH /api/v1/links/:id/policy` `{ask, coordinate, act, dailyLimit}` | 自分が受け取る側の方針 |
| `DELETE /api/v1/links/:id` | 取り消し |
| `POST /api/v1/approvals/:messageId` `{decision}` | `approve`／`decline` |
| `GET /api/v1/links/:id/timeline` | 直近100件（本文、intent、承認、配達、処理結果） |

- **頻度の上限**（DBの固定窓）：
  - 認証の入口：IPごとに毎分20回、全体で毎分200回
  - ログイン後の書き込み：人ごとに毎分60回
  - 招待の発行：人ごとに1日20件
  - IPで拒否した要求は全体の枠を消費しない（書籍164頁のロックアウト対策）
- 転送元IPのヘッダーは、Renderのプロキシを1段だけ信頼する（`TRUST_PROXY_HOPS=1`）。

## 画面

Home（承認待ちと最近のやりとり）、Agents、People（Contactと招待）、Link（方針とタイムライン）の4つ。UUIDは詳細の中に隠し、表示名・provider・状態・相対時刻を主役にする。表示名や本文は必ず `textContent` で描画し、HTMLとして解釈させない。

## 運営の操作

`node dist/admin.js` に残すのは次の4つだけ。それ以外の手作業での登録・通信許可は削除する。

- `signup_invite`：任意で `ownerId` を指定できる。招待URLは0600の秘密ファイルへ書き出す
- `disable`：緊急停止
- `revoke`：組の取り消し
- `status`：読み取りの診断
