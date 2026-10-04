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

## フォルダの表示順

[config/folder-order.json](config/folder-order.json) の `active`（General）と `archive` に、フォルダ名を上から表示したい順に記載します。現在は2026-10-04時点のローカルFragmentBoxの並び順を写しています。

- 設定にないフォルダは末尾へ名前順で追加します。記事がないフォルダは表示しません。
- フォルダ名は大文字・小文字を含めて完全一致で指定します。同じarea内の重複や不正な形式は検証エラーになります。
- 変更後は `npm test` と `npm run build` で確認し、設定をコミットして通常の公開手順で反映します。vaultの再同期やDBの変更は不要です。
- 順序は全端末で共通です。更新前のページ送りは再取得を促す表示になります。

FragmentBoxと合わせ直す際は、PC側の画面の順序をこの設定へ写します。Generalの保存元は `active/.navigation-order.json`（`inbox:` は `inbox`、`notes:名前` はフォルダ名）、Archiveは `archive/.folder-order.json` です。順序ファイルにないフォルダもPC側の表示位置を確認して追記してください。自動同期は行わず、FragmentBoxやvaultは変更しません。
