# 確認済みの vault 形式

PC 版 FragmentBox の `viewer.py` / `fragmentbox.py` の処理と、Git 作業ツリーが clean な時点の vault を確認しました。確認時点では記事が209件ありました。このページは現在の形式を記録します。記事本文や実ファイル名は公開例として掲載しません。

## 配置とファイル名

同期対象は `fragmentbox/active/<folder>/*.md` と `fragmentbox/archive/<folder>/*.md`、および本文から参照される `fragmentbox/assets/` 内の添付です。アプリは active と archive、同名フォルダを別々に扱います。Markdown は UTF-8 で、YAML front matter はありません。記事本文を読み込み、前後の空白を除いて保存します。

記事のファイル名は `YYYYMMDD_HHMMSS.md` または `YYYYMMDD_HHMMSS_<1〜6桁>.md` です。時刻は FragmentBox が作成したローカル時刻（Asia/Tokyo、UTC+09:00）として扱い、保存時に UTC へ変換します。存在しない日付や時刻、規則外のファイル名は同期エラーにします。ファイルの更新日時は記事日時に使いません。記事の更新日時は、そのパスを最後に変更した Git commit の時刻から求めます。

記事の安定 ID は active/archive からの相対パスを基にします。フォルダ移動、active/archive 間の移動、改名は同期上で旧記事の削除と新記事の追加になります。

日時はミリ秒精度で保存します。不正なファイル名をcheckout時の更新時刻で補うことはしません。

## タイトルとタグ

本文中の URL カードは、本文が URL で始まり、次の行が `title:` で始まるとき、その行から表示用タイトルを取ります。該当しない場合は、最初の空でない非画像行を使い、先頭の Markdown 見出し記号を除きます。`title:` などのカード情報は本文内の通常行で、front matter ではありません。

タグは PC 版と同じ `#(\w+)` の規則で本文から読み取ります。Unicode の文字・数字と `_` がタグ名に含まれます。本文のどこに書かれていても認識し、同じタグの重複は一覧で一つにまとめます。

## 画像・添付

ローカル画像は Markdown の画像リンクで `assets/` を参照します。対応形式は WebP、PNG、JPEG、GIF、SVG、BMP、TIFF です。添付ファイルは通常の Markdown リンクで同じ場所を参照し、`attachment_` と32桁の16進数、拡張子からなる名前を使います。対応する添付形式は PDF、TXT、Markdown、CSV、JSON、MP3、WAV、AIFF、FLAC、M4A、OGG、MIDI です。参照先は vault の `assets/` 直下に限定し、パス traversal、シンボリックリンク、欠落ファイル、未対応形式は同期エラーにします。

同期対象は記事から実際に参照されるファイルだけです。未参照の孤立ファイルは同期しません。外部 URL の画像をダウンロードしたり埋め込んだりせず、外部 URL は明示的なリンクとして扱います。

サムネイルは縦横320px以内のWebPで、拡大せず生成します。原本とサムネイルはそれぞれ内容ハッシュで重複を除去します。1記事の添付は最大32個、タグは最大64個・各100文字、本文は256 KiB、添付1個は100 MiBまでです。索引などを含めた1行の文字列データは1.8 MBまでとし、上限を超えた場合は黙って省略せず同期エラーにします。

## ローカルでの規模確認

実 vault の本文や添付データを Cloudflare へ送る前に、次のローカル inspect で件数・添付容量・SQLite の概算を確認できます。

```sh
npm run sync -- --vault /path/to/fragmentbox --inspect
```

このモードは Git 作業ツリーが clean であることを確認し、Cloudflare へ接続せず、パスや本文を出力しません。`estimatedDatabaseBytes` はインメモリ SQLite のページサイズから算出した値で、D1 の実使用量を保証しません。remote dry-run と apply は[セットアップ手順](setup.md#vault-同期)に従います。
