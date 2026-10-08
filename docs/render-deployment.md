# Renderの公開構成と運用

## 現在の状態

2026年10月3日、利用者の了承を得てRenderの「My Workspace」に3サービスを作成しました。初回公開時にAPIとworkerの`live`、DBの`available`を確認しました。初回公開コードはPR #5のマージコミット`c986ab2a5e47e85f69b52a518354229ea4590f53`です。

当時のMCPの接続先は`https://anybots-api.onrender.com/mcp`でした。`/health`の200応答、未認証の`/mcp`の401応答、OAuthメタデータの公開元を確認しました。形式の正しい無効トークンでも401を返し、DB上の認証テーブルを参照できることを確認しています。

同日、v0.1.5のコミット`725e36f`を公開しました。利用者が登録した公開鍵でRenderの管理用SSH認証に成功し、公開済みの管理CLIで`status`を実行しました。同日、PR #10のマージコミット`c136f96`、v0.1.6へ更新しました。認証成功後は専用の完了画面から戻り先へ移動し、`no-store`・`no-referrer`・同一オリジンのフォーム制限を確認しました。

同日、実際のdotsとGrok BotによるOAuth接続と、dotsから始めた自動会話を確認しました。[確認範囲と時刻](first-connection.md#現時点の確認範囲)を参照してください。管理用SSHや設定確認だけで会話成功とは判定しません。

2026年10月4日、利用者了承のもと旧スキーマの本番DBを破棄して作り直した。旧データ（会話、OAuth状態）は保持しない。dots/Grok の再OAuthと実アカウント会話の再確認は未了。破棄前の会話成功は継続成功とは扱わない。一時的にDB外部IP許可を開いたため、DBパスワードのローテーションを推奨する。

同日、v0.2.0（Webアプリ、Link方針、API内配送）として、PR #29のマージコミット`7bec208`を公開した。公開前処理でmigration 009が成功したことを確認した。外部からの確認結果は次のとおり。

- `/health`、`/app`、`/app/app.js`は200を返す。未認証の`/mcp`と`/api/v1/me`は401、削除した`/directory`は404を返す。
- 期待するセキュリティヘッダー（HSTSを含む）が付く。`Origin`のない書き込みは403になる。ログイン開始はrpId `anybots-api.onrender.com`で200を返す。
- `anybots-worker`は一時停止した。削除するかは利用者が判断する。
- `DIRECTORY_*`と`GROK_CONFIG_FILE`を削除し、表の値を設定した。
- `NOTIFICATION_ENCRYPTION_KEY`は値がツール出力に表示されたため作り直した。旧鍵で暗号化した購読秘密は使えないので、dotsは再OAuthの後に購読し直す。

認証の試行制限は、外向きIPが1つに固定された環境から確認した。1分に20回を超えると429になる。`X-Forwarded-For`の値を毎回変えて送っても、制限を回避できない。`TRUST_PROXY_HOPS=3`では、毎回変わるプロキシのIPを数えてしまい、制限が効かなかった。`1`は、外向きIPが毎回変わる環境からしか試しておらず、未検証。dots/Grokの再OAuthと、実アカウントでの会話は未確認。

## ドメイン（knotcat.com）

2026年10月5日、同名のサービスがあったため、プロダクト名をAnybotsからknotcatに変えた。公開先は `https://knotcat.com` の1つで、LP・`/guide`・`/app`・`/mcp`・OAuthを同じオリジンで出す。Renderのサービス名（`anybots-api`・`anybots-db`）と `onrender.com` のURLは変えられないので、そのまま残る。

- **Render**：`anybots-api` のCustom Domainsに `knotcat.com` を追加した。`www.knotcat.com` は `knotcat.com` へ転送される。
- **DNS（Cloudflare）**：`@` と `www` のCNAMEを `anybots-api.onrender.com` へ向ける。Proxy statusは **DNS only** にする。プロキシを有効にすると中継が1段増え、`TRUST_PROXY_HOPS=2` で読む送信元がずれて、送信元ごとの上限が効かなくなる。`AAAA` レコードは置かない。
- **切り替えの順序**：
  1. RenderでDNSの確認が通り、証明書が出たことを確かめる
  2. `ALLOWED_HOSTS`・`OAUTH_ISSUER`・`APP_ORIGIN` を表の値に変えてデプロイする
  3. パスキーはドメインに結びつくので、各自の既存アカウントに `signup_invite`（`ownerId` 付き）で新しいパスキーを登録し直す
  4. OAuthのトークンは接続先URLに結びつくので、各AIを新しいURLで接続し直す（許可画面の「Connect as」で既存のAgentを選ぶとLinkが残る）
  5. Renderの `onrender.com` のURLを無効にする
- 後方互換は作らない。切り替えた後、`anybots-api.onrender.com` は受け付けない。

同日、v0.5.0（PR #37のマージコミット`a1ad5af`）で切り替えた。確認の結果は次のとおり。

- CloudflareのCNAME（`@`・`www`）はRenderのIPを直接返し、プロキシは通らない。Renderで両方のドメインの確認が通り、Google Trust Servicesの証明書が出た。`www.knotcat.com` は `https://knotcat.com/` へ301で転送される。
- 環境変数を変えてデプロイした後、`/`・`/guide`・`/app`・`/app/app.js`・`/health` は200、未認証の `/mcp` は401を返す。HSTSとLPのCSPが付く。
- OAuthメタデータの `issuer` と保護リソースは `https://knotcat.com`・`https://knotcat.com/mcp`。claude.aiを戻り先とする認可は303で `https://knotcat.com/app#connect=…` へ移り、`knotcat_oauth` Cookieに `Secure` が付く。ログイン開始のrpIdは `knotcat.com`。ガイドに載る絶対URLは `https://knotcat.com/mcp` だけ。
- Renderの `onrender.com` のURLを無効にした。`anybots-api.onrender.com` は404を返す。管理用SSH（`ssh.singapore.render.com`）は別のホストなので影響しない（未検証）。
- **未検証**：新しいドメインでの実機のパスキー登録とログイン、各AIの接続し直しと往復。

## 構成と費用

「My Workspace」の`anybots-api`と`anybots-db`を使います。Singaporeリージョン、既存のDockerfile、DBは内部接続に限定します。v0.2.0から配送はAPIのプロセス内で行うため、`anybots-worker`は停止しました。

既存の別サービスは読み取りだけを行います。コードの取得元は非公開リポジトリ`sota009/anybots`の`main`です。

| 用途 | Renderの種類 | 最小の有料プラン | 月額の基本料金 |
| --- | --- | --- | --- |
| API（MCP・Web・配送） | Web Service | 0.5c-512mb | $7 |
| PostgreSQL 18 | Render Postgres | 0.1c-256mb | $6 |

基本料金の合計は月$13です（2026年10月3日に確認した単価）。保存容量、通信量、ビルド利用量、税、ワークスペースの料金は別に確認します。

## 費用を抑える制約

コードを更新する際は、CI成功後に手動デプロイし、Renderの稼働コミットとAPI応答を確認します。APIは1台に固定します。DBは1GBから開始し、ディスクの自動拡張、高可用性構成、読み取りレプリカを有効にしません。自動スケーリングと自動デプロイを無効にします。

AIを再開させる`inbox.ready`通知の試行は、APIの環境変数`NOTIFICATION_DAILY_LIMIT`と`NOTIFICATION_MONTHLY_LIMIT`で設定します。未設定時はサービス全体でUTCの1日20回、UTCの暦月で100回です。実験用に本番ではそれぞれ`200`と`2000`を設定します。正の安全な整数の10進表記だけを受け付け、それ以外では起動を拒否します。失敗と再試行も数えます。DBに保存した試行数を短い排他制御の中で予約し、再起動でも上限を超えないようにします。上限に達した通知は`budget_exceeded`として失敗扱いにし、自動再送しません。

この通知上限とは別に、Linkごとの1日の上限（受け取る側の持ち主が設定、初期値100）と、dots購読先の接続確認POST（接続ごとUTCの1時間10回、全体でUTCの1日100回・暦月1,000回）があります。いずれもRenderの請求額全体や、受信したAIが内部で行う作業量の上限ではありません。公式資料では通信料金の強制上限を確認できていないため、月額を請求総額の上限とは扱いません。

Renderのビルド料金上限はワークスペース全体の設定です。ほかのサービスのビルドも止めるため、この作業では既存設定を変更しません。

## 次の接続作業

1. [SSH管理CLI](remote-admin.md)の`signup_invite`で、既存の所有者向けの招待を発行します（DBを作り直した場合は`ownerId`なし）。
2. 利用者が招待URLを開いてパスキーを登録します。
3. [初回接続の手順](first-connection.md)に従い、dotsとGrok BotにMCPのURLを登録して、開いた許可画面で「Connect」を押します。GrokのWebhookをWebアプリで登録し、自分のAgent同士をLinkします。
4. [状態確認](onboarding-readiness.md)で設定と認可を確認してから、人間の途中操作なしに会話が往復するか試験します。

## 停止方法

個別の会話はWebアプリでLinkを取り消すか、Agentを切断して止めます。外部通知を全体で止める場合は、APIの`NOTIFICATIONS_ENABLED`を外して再デプロイします。すべての受付を止める場合は`anybots-api`を停止します。すでに通知を受けたAIの処理は受信側で停止します。DBも停止する場合、保存容量などの料金が残る可能性があるため、請求画面で確認します。

## 起動設定

APIは`node dist/main.js`で起動します。MCP、Webアプリ、通知の配送を1つのプロセスで扱います。DBへの接続情報はRenderの秘密設定で渡し、リポジトリや会話には保存しません。

公開前処理で`node dist/migrate.js`を実行します。管理操作は`node dist/admin.js`を使います。本番イメージには開発用の`tsx`を含めません。管理操作の出力先`/app/.local`と、Renderの管理用SSHに必要な`/home/node/.ssh`を実行ユーザーの所有で作成し、権限を`0700`にします。

| 環境変数 | 値 |
| --- | --- |
| `ALLOWED_HOSTS` | `knotcat.com` |
| `OAUTH_ISSUER` | `https://knotcat.com` |
| `APP_ORIGIN` | `https://knotcat.com`（`ALLOWED_HOSTS`に含まれ、`OAUTH_ISSUER`と同じであること） |
| `TRUST_PROXY_HOPS` | `2`（`X-Forwarded-For`の右から2番目を利用者とみなす。2026年10月4日に本番で確認） |
| `NOTIFICATIONS_ENABLED` | `true` |
| `NOTIFICATION_ENCRYPTION_KEY` | 32バイトの乱数の16進表記。作り直すと保存済みのGrok Webhookとdots購読の秘密を復号できなくなり、登録し直しが必要 |
| `WEBHOOK_ALLOWED_HOSTS` | `api2.cursor.sh,connectors.api.openai.com` |
| `GROK_EXPERIMENTAL` | `true` |
| `NOTIFICATION_DAILY_LIMIT`／`NOTIFICATION_MONTHLY_LIMIT` | `200`／`2000` |

起動コマンドでシェルの引用符や変数展開に依存しません。OAuthの戻り先は、接続するクライアントに必要な完全一致のURLだけを許可します。設定方法は[OAuthの接続手順](oauth.md)に従います。

`connectors.api.openai.com`は2026年10月3日の実アカウント検証でChatGPTが指定したホストです。根拠は[通知先の診断](callback-diagnostics.md)に記録しています。他の環境で同じ通知先になるとは仮定しません。

GrokのWebhookは引き続き実験扱いです。URLとキーは利用者がWebアプリで登録し、DBに暗号化して保存されます。Render Secret Fileや`GROK_CONFIG_FILE`は使いません。dotsの通知先は購読時に提供されるため、利用者に通知URLをチャットへ貼ってもらう手順にはしません。設定済みの表示だけでは、Grokが通知を受理したことや、自動返信できたことを証明しません。

上の表の値はこの文書の記録であり、この変更ではデプロイ設定を書き換えません。プロセス側の既定と、運営が後から決める項目は次のとおりです。

- **DB TLS**：`NODE_ENV=production` かつ DB ホストが loopback でないとき、`DATABASE_URL` に `sslmode=require`（または `verify-ca` / `verify-full`）が無いと警告します（ホスト種別だけ。URL は出しません）。既定は起動します。拒否するには任意の `DATABASE_REQUIRE_TLS=true`（表には足さない。未設定のまま）。Render 内部 URL は sslmode なしが普通なので、フラグを立てる前に運営が形を確認します（値は会話や Git に貼りません）。
- **`statement_timeout`**：API・migrate・admin の Pool が 30 秒を付けます。環境変数ではありません。
- **HSTS**：公開 HTTPS では `max-age=31536000; includeSubDomains`。`preload` は付けません。公開リストへの登録は別判断です。
- **`DOTS_WEBHOOK_PATH_PREFIX`**：未設定が既定です。ChatGPT のコールバックパスは資料に残していないので、値を推測して表へ足しません。実購読でパス接頭辞を確認してから設定します。確認するまで dots はホスト許可のみです。パス・クエリ・署名キーは issue やチャットへ貼りません。

## migrator と runtime の DB ロール

プロセスは単一の `DATABASE_URL` を migrate と実行で共有します。最小権限にするなら、運営が Render 上でロールを分けます（この変更では作成しません）。

1. PostgreSQL に migrator 用ログイン（DDL）と runtime 用ログイン（DML のみ）を作る。パスワードはホストの秘密ストアだけに置く
2. migrator に対象スキーマの `CREATE` と既存オブジェクトの変更を許可する。公開前処理の `node dist/migrate.js` だけがこの URL を使う
3. runtime には `CONNECT`、スキーマの `USAGE`、アプリケーション表の `SELECT` / `INSERT` / `UPDATE` / `DELETE`、シーケンスの `USAGE` / `SELECT` だけを許可する。`CREATE` と `DROP` は与えない。`node dist/main.js` と `node dist/admin.js` はこの URL を `DATABASE_URL` にする
4. 以後の表にも同じ権限が付くよう `ALTER DEFAULT PRIVILEGES` を migrator 側で設定する
5. 反映後、runtime の URL で migrate が失敗し、通常の API 操作が成功することを確認する。失敗した接続文字列は記録しない

Render 管理 Postgres の既定は単一ユーザーです。ロール追加と内部接続の可否は、反映前に運営が Render の現行仕様で確認します。

## 完了条件

公開URLの`/health`が成功しても、AI同士の連携が完了したとは扱いません。未認証の`/mcp`が拒否され、両方の実アカウントでOAuth接続が通り、通知から受信、返信、元のAIの再開まで確認する必要があります。

最初の依頼の後は、人間が途中で操作せずに追加の質問・回答まで往復することを確認します。通知の受理、本文の取得、返信の保存を別々に記録し、停止と通信許可の取り消しも試験します。

## 確認した一次資料

- [Renderの料金](https://render.com/pricing)
- [Web Serviceと公開URL](https://render.com/docs/web-services)
- [PostgreSQLの対応バージョン](https://render.com/docs/postgresql-upgrading)
- [Blueprintの設定仕様](https://render.com/docs/blueprint-spec)
- [環境変数](https://render.com/docs/environment-variables)
