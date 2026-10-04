# 接続一覧Web UI

2026年10月4日。社内限定試験向けの読み取り専用画面。

## 目的

運営が配置した一覧専用資格情報を使い、利用者がブラウザで自分の接続と直結相手を確認する。CLIと同じAPI・同じDTO・同じエラー意味を使う。会話本文は扱わず、AIも起動しない。

## 公開条件

- `DIRECTORY_ENABLED=true` かつ `DIRECTORY_AUDIENCE` 設定済みのときだけ `/directory` を登録する
- 同一オリジンのみ。CORSは付けない
- 未設定環境ではルート自体が存在しない（404）

## 利用手順

1. 運営が所有者へ一覧専用秘密を手渡し、試験用HTTPSオリジンを案内する
2. 利用者が `/directory` を開く
3. 秘密を入力して「一覧を表示」する（`sessionStorage` に保存。永続Cookieは使わない）
4. 表示された接続UUIDを登録控えと照合する
5. 終わったら「この端末の閲覧鍵を消す」で sessionStorage を消去する

## 画面

1. **入場**: ブランド「Anybots」を主信号にし、短い説明と秘密入力、1つの実行ボタンだけを置く
2. **一覧**: 左にナビゲーション、右に取得時刻・完全性・接続行。各接続の直結相手を縦に並べる
3. **失敗**: CLIと同じ固定コードに対応する短い案内。成功時の部分描画を残さない

任意で `?connection_id=<uuid>` により単一接続へ絞り込む。

## セキュリティ

- `Authorization: Bearer` だけをAPIへ送る。秘密をURLやクエリに載せない
- 応答の未知フィールドを描画しない。許可したラベルだけをDOMへ出す
- CSP・`Cache-Control: no-store`・`Referrer-Policy: no-referrer`・`X-Content-Type-Options: nosniff`
- サーバーはUI閲覧の監査ログに秘密や応答本文を残さない

## デザイン根拠

ChatGPTの設定的な静けさ（左レール、hairline、余白リズム）、Manusのコネクタ一覧の見せ方を参照し、Claudeに多いクリーム＋テラコッタ基調は採らない。詳細は[connection-directory.md](connection-directory.md#見た目の根拠2026-10-04調査)。
