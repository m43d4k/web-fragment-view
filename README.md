# Fragment View

FragmentBox の vault をスマートフォンから読むための非公開 Web アプリです。初期設定と同期の手順は [セットアップガイド](docs/setup.md) を参照してください。
記事ファイルと日時・タグ・添付の対応は [vault形式](docs/vault-format.md) に記載しています。

UI・API・同期エンジンを実装しています。確認済みの FragmentBox 形式とローカル inspect の使い方は [vault形式](docs/vault-format.md) を参照してください。

## ローカルで起動

Node.js 22.22.1 以降を使います。

```sh
npm ci
npm run demo
```

`npm run demo` は合成データを使った一時的なプレビューを `http://127.0.0.1:8787` で起動します。Ctrl+Cで停止します。

Workerのローカル環境を使う場合は、デモを停止して `npm run db:migrate:local`、`npm run dev` の順に実行します。この環境はデモとは別の空のデータベースを使います。

変更の確認には `npm run typecheck`、`npm test`、`npm run build` を使います。`npm run build` は Wrangler の dry-run です。

vault のリモート同期は、[セットアップガイド](docs/setup.md#vault-同期)を確認してから実行してください。
