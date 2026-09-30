# セットアップと運用

GitHub と Cloudflare の設定・リソース作成は、このリポジトリの所有者が行います。このガイドは手順と必要な値を示します。ローカル検証を先に済ませ、無料枠・契約・実データの容量を確認してからリモート資源を作成してください。同期は D1 の内容を追加・更新・削除し、R2 に画像を保存します。

## 1. ローカルで確認

Node.js 22.22.1 以降を使い、依存関係をロックファイルどおりに入れます。

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run demo
```

`npm run build` は Worker の Wrangler dry-run です。`npm run demo` は合成データだけを使い、`http://127.0.0.1:8787` で起動します。デモはCtrl+Cで終了します。

Workerの永続的なローカル環境を確認する場合は、デモを停止した後、`npm run db:migrate:local` と `npm run dev` を実行します。設定ファイルの `DB` / `BUCKET` バインディングと `local` 環境を使います。デモの一時データは引き継ぎません。

記事・日時・タグ・添付の解釈は[確認済みの vault 形式](vault-format.md)にまとめています。リモート設定前に合成データによるテストを通し、実 vault の規模はローカルの inspect で見積もります。vault 本文や実ファイルを公開 fixture やログへコピーしないでください。

```sh
npm run sync -- --vault /path/to/fragmentbox --inspect
```

`--inspect` は Git 作業ツリーを読み取り、集計値だけを表示します。Cloudflare 接続・認証情報は不要です。SQLite のメモリ上で算出する DB サイズは D1 の実使用量と一致する保証はありません。リソース作成後の remote dry-run は D1/R2 を読み取り、差分件数と転送量を確認します。

## 2. Cloudflare リソース・独自ドメイン・認証

公開先は `https://fragment.m43d4k.fyi` です。取得済みの `m43d4k.fyi` のサブドメインを Worker の **Custom Domain** として使います。まず、このドメインのゾーンが Worker と同じ Cloudflare アカウントで Active になっていることを確認します。

1. Cloudflare アカウントに D1 データベースと非公開 R2 バケットを作成します。`wrangler.jsonc` の `DB` / `BUCKET` binding と、D1 database ID・R2 bucket 名を一致させます。R2 の公開開発 URL・公開カスタムドメインは有効にしません。
2. ローカルの D1 migration と demo を確認後、対象のリモート D1 に migration を適用します。同期は `sync_state` 行と初期スキーマを必要とします。移行コマンドの `--remote` はリモート変更です。対象名と費用を確認したうえで所有者が実行します。
3. 公開前に、Cloudflare One の Access → Applications で **Self-hosted** アプリケーションを追加します。名前は `Fragment View`、Public hostname はサブドメイン `fragment`、ドメイン `m43d4k.fyi`、Path は空欄にしてホスト全体を保護します。Allow ポリシーの Include → Emails に本人のメールアドレス 1 件を指定し、利用するログイン方法を設定します。Bypass や Everyone の許可は追加しません。
4. Access の設定値を `wrangler.jsonc` のトップレベルの `vars` に記入します。`ACCESS_TEAM_DOMAIN` は `<チーム名>.cloudflareaccess.com`（`https://` や末尾の `/` を含めない）、`ACCESS_AUD` はこの Access アプリケーションの Application Audience (AUD) Tag、`ALLOWED_EMAIL` は許可した本人のメールアドレスです。`ACCESS_TEAM_DOMAIN` に `fragment.m43d4k.fyi` を入れないでください。
5. `wrangler.jsonc` のトップレベルに次の `routes` を追加します。既存の `workers_dev: false` と `preview_urls: false` は維持します。

   ```jsonc
   "routes": [
     { "pattern": "fragment.m43d4k.fyi", "custom_domain": true }
   ],
   ```

   Custom Domain の設定には `https://` や `/*` を付けません。Cloudflare が DNS レコードと証明書を作成するため、事前に `fragment` の A / CNAME レコードを手動作成する必要はありません。同名の既存レコードがある場合は用途を確認し、競合を解消してから進めます。特に既存 CNAME があるホスト名には Custom Domain を作成できません。[Custom Domains 公式手順](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
6. 設定後に `npm run build` で dry-run を確認します。Access・D1・R2 の設定と料金を確認したうえで、所有者が次のコマンドを実行します。これは Worker の公開と、Custom Domain・DNS・証明書の設定を伴います。

   ```sh
   npx wrangler deploy --env=""
   ```

7. Workers & Pages → `fragment-view` → Settings → Domains & Routes で `fragment.m43d4k.fyi` が設定され、証明書が有効になったことを確認します。`https://fragment.m43d4k.fyi` を開き、本人の Access ログイン後に閲覧できることを確認します。未ログインの別ブラウザでは UI・API・添付が取得できず、`workers.dev` と preview URL に迂回できないことも確認します。データ表示の確認は後述の初回同期後に行います。

Access は同じホストの `/api/*` と画像・添付にも適用します。R2 の公開 URL・カスタムドメインは作成しません。Access の設定は [Self-hosted アプリの公式手順](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)を参照してください。上記の公式手順は 2026-09-30 JST に確認しました。

Worker は `ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`ALLOWED_EMAIL` を環境設定として読みます。これらの値は GitHub の同期用 Secrets へ置く必要はありません。同期用 Cloudflare API token は対象アカウントと D1 の編集に必要な権限だけに絞ります。R2 は同期専用 S3 access key を作り、その bucket で必要な読み書きだけを許可します。同期資格情報を Worker の変数へ設定しないでください。

Cloudflare API token と R2 access key は別の認証情報です。D1 の API token は GitHub Actions の Secret として管理し、R2 の access key ID と secret access key も別々の Secret にします。

## 3. アプリのpushで自動ビルド・公開

初回の手動公開とAccessの確認が済んだら、既存 Worker に **Workers Builds** のGitHub連携を設定します。以後は、このアプリの `main` へpushするとCloudflare側で検証・ビルド・デプロイし、`https://fragment.m43d4k.fyi` を更新します。

1. 上で設定した `wrangler.jsonc`（D1 ID、R2名、Access設定、Custom Domain）をアプリのリポジトリへcommit・pushします。トークンや秘密鍵は含めません。
2. Cloudflare の Workers & Pages → `fragment-view` → Settings → Builds → Connect からGitHubを接続し、このアプリのリポジトリを選びます。GitHub Appには対象リポジトリへのアクセスを許可します。
3. 以下を設定します。接続・保存時にも初回ビルドが起動し得るため、先に公開先と設定値を確認してください。

| 設定 | 値 |
| --- | --- |
| Worker名 | `fragment-view`（`wrangler.jsonc` の `name` と一致） |
| Git repository | `m43d4k/fragment-view`（アプリを別名で作成した場合はそのリポジトリ） |
| Production branch | `main` |
| Root directory | リポジトリ直下 `/` |
| Build command | `npm ci --include=dev && npm run typecheck && npm test && npm run build` |
| Deploy command | `npx wrangler deploy --env=""` |
| 非本番ブランチの自動ビルド | 無効 |
| Build variable: `SKIP_DEPENDENCY_INSTALL` | `true`（上記の `npm ci` でインストール） |
| Node.js | リポジトリの `.node-version` を使用 |

Build commandが失敗した場合はデプロイへ進みません。`npm run build` 自体はdry-runなので、Deploy commandも必要です。GitHubのCIとは独立して動くため、Cloudflare側でも型チェック・テストを実行します。

デプロイ用API tokenはWorkers Buildsの接続画面で設定します。自動生成されるtokenを使う場合も、対象アカウントと権限を確認してください。vault同期用の `VAULT_READ_TOKEN` やR2のS3キーは、このビルドに設定する必要はありません。Workerの実行時設定は `wrangler.jsonc` に記入した値を使い、Build Variablesと混同しないようにします。

4. 接続後、アプリの次の変更を `main` へpushします。Cloudflareのビルド履歴で対象コミット、テスト成功、デプロイ成功を確認し、本人のAccessログイン後に画面の変更を確認します。認証設定を変更した場合は未ログイン時の拒否も再確認してください。

アプリのデプロイではvault同期とD1 migrationは実行しません。スキーマを変更する場合は、互換性と適用順序を確認し、所有者がmigrationを適用してから対応するアプリを公開します。

Workers Builds Freeは月3,000ビルド分です。GitHub Actionsの枠とは別に、Cloudflareの契約と残量を確認してください。公式資料確認日：2026-09-30 JST。[ビルド設定](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)、[ビルド環境](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)、[料金・制限](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/)。

### 設定完了後の2つの更新経路

| push先 | 起動条件 | 実行場所と反映先 |
| --- | --- | --- |
| アプリのリポジトリ | `main` へのpush、Workers Builds接続済み | Cloudflareで検証・ビルド → WorkerとUIを更新 |
| `m43d4k/fragments` | `main` の `fragmentbox/**` を変更してpush、通知・Secrets・自動同期設定済み | GitHub Actionsで同期 → Cloudflare D1・R2を更新 |

vault側の設定は次の節で行います。ローカルで保存・commitしただけでは、どちらの更新も始まりません。

## 4. GitHub Actions の設定

### 閲覧アプリのリポジトリ

このリポジトリの Settings → Secrets and variables → Actions に次を設定します。

| 種類 | 名前 | 用途 |
| --- | --- | --- |
| Secret | `VAULT_READ_TOKEN` | `m43d4k/fragments` の `contents: read` のみを許可する fine-grained token |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | 同期先 Cloudflare account ID |
| Secret | `D1_DATABASE_ID` | 同期先 D1 database ID |
| Secret | `CLOUDFLARE_API_TOKEN` | 対象アカウントの D1 同期用 API token |
| Secret | `R2_BUCKET_NAME` | 同期先の非公開 bucket 名 |
| Secret | `R2_ACCESS_KEY_ID` | 同期用 R2 S3 access key ID |
| Secret | `R2_SECRET_ACCESS_KEY` | 同期用 R2 S3 secret access key |
| Variable | `SYNC_ENABLED` | push 通知を受けて自動同期するときだけ文字列 `true` にする |

同期 workflow の手動実行は初期状態で dry-run です。`apply` を明示的に true にした場合だけ D1/R2 を変更します。自動 push 同期を有効にする前に、手動 dry-run の件数・アップロード容量・削除件数をレビューし、初回同期の `apply` を所有者が実行してください。同期先の D1 は先に migration 済みである必要があります。

GitHub Actions では、リポジトリの Actions 実行を許可し、GitHub-hosted runner の利用枠を確認してください。Workflow は `main` を同期元として毎回取り直します。古い push 通知の SHA へ戻すことはありません。同期は直列化されます。

同期は最後に完了したコミットだけでなく、最後に試行したコミットも記録します。新しい同期が途中失敗した場合も、その同じコミットか子孫コミットで再実行してください。force-push等で履歴を置き換えた場合は自動的に巻き戻さずエラーになります。

### vault リポジトリからの通知

このリポジトリは別リポジトリへの push だけでは起動しません。`docs/vault-notify.yml.example` を `m43d4k/fragments` の `.github/workflows/fragment-view-notify.yml` に所有者がコピーして有効にします。vault リポジトリ側へ次を設定してください。

- Secret `VIEW_DISPATCH_TOKEN`: 閲覧アプリの `repository_dispatch` を呼ぶための fine-grained token。対象リポジトリの Contents 書き込みを許可します。
- Variable `VIEW_REPOSITORY`: `m43d4k/fragment-view`。

この通知 workflow は vault リポジトリの `main` に push された場合に `vault-push` event を送ります。閲覧アプリ側の `SYNC_ENABLED` が文字列 `true` になるまで、自動同期 workflow は実行しません。PAT は短い期限にし、用途を限定して管理してください。

通知 workflow を有効にする前に、手動 dry-run を確認し、Cloudflare リソースと同期先を再確認します。GitHub Actions の有効化と Secret 設定はリモート設定の変更です。

## 5. vault 同期

CLI は `CLOUDFLARE_ACCOUNT_ID`、`D1_DATABASE_ID`、`CLOUDFLARE_API_TOKEN`、`R2_BUCKET_NAME`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY` を環境変数から読みます。いずれも同期先の資格情報です。ログへ値を出さないでください。

ローカルでの remote dry-run は次のとおりです。これはリモート D1 を読み、添付の有無を R2 に問い合わせるため、同期資格情報と migration 済み D1 が必要です。D1/R2 への書き込みはしません。実データの規模だけを確認するときは、認証情報を使わない `--inspect` を先に実行してください。

```sh
npm run sync -- --vault /path/to/fragments/fragmentbox
```

出力された作成・更新・削除の件数とアップロード容量が妥当な場合、`--apply` を付けて実行すると D1/R2 を変更します。vault から記事がなくなった場合、対応する D1 記事は削除されます。意図した空の vault を反映するときだけ `--allow-empty` も指定できます。操作対象と変更内容を再確認してから実行してください。

同期実装は通常の同期では古い未参照 R2 オブジェクトを削除しません。ガベージコレクションの `--gc` は7日以上経過した未参照オブジェクトを削除するため、専用の確認なしに定期 workflow へ追加しないでください。空 snapshot の扱いや上限は CLI の失敗を成功扱いにせず、原因を調べてから再実行してください。

反映の標準上限はvault全体で1,000記事です。これを超える場合、dry-runで容量と件数を確認し、`--max-articles <件数>` を明示してください。この値は課金上限ではありません。D1の無料枠に達したときは失敗として止まり、枠が回復してから再実行します。

`--gc --apply` は、処理が一時停止しても他の同期が割り込まない保守ロックを保持します。通常終了・例外では解放しますが、強制終了時は残ります。復旧時はGitHub Actionsとローカルの該当プロセスが完全に停止したことを確認してから、所有者がD1コンソールで `sync_state` の `lock_owner` と `lock_until` をNULLにします。動作中のプロセスがある状態では解除しないでください。

### 同期で使う値

| 環境変数 | 設定場所 | 用途 |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub Secret / ローカル環境 | D1 API と R2 endpoint のアカウント |
| `D1_DATABASE_ID` | GitHub Secret / ローカル環境 | 同期先 D1 |
| `CLOUDFLARE_API_TOKEN` | GitHub Secret / ローカル環境 | D1 query API |
| `R2_BUCKET_NAME` | GitHub Secret / ローカル環境 | 同期先 R2 bucket |
| `R2_ACCESS_KEY_ID` | GitHub Secret / ローカル環境 | R2 S3-compatible API |
| `R2_SECRET_ACCESS_KEY` | GitHub Secret / ローカル環境 | R2 S3-compatible API |

API token、S3 key、PAT はパスワードマネージャー等で保管し、リポジトリへ commit しないでください。ローカルでも `.env` ファイルを共有・ログ出力しないでください。

## 6. 変更後の確認

Worker や認証設定を変更したら、未ログイン時の UI・API・添付がすべて拒否されること、許可した Access identity のみ使えること、preview と `workers.dev` に迂回路がないことを確認します。同期を変更した場合は合成 fixture でテスト後、dry-run で件数・削除候補・転送量を確認します。

料金と上限は実行日に公式資料を読み直し、現在のアカウント使用量を含めて判断します。[SPEC.md の参考リンク](../SPEC.md#無料枠の確認)を参照してください。無料枠は停止上限ではなく、超過で課金が発生する場合があります。
