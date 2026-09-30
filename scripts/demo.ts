// All state and files for this preview are temporary synthetic data.
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import sharp from 'sharp';
import { handleRequest, type Env } from '../src/worker/index';
import { syncVault, type Database } from './sync/engine';
import { normalizeSearch, searchTokens } from '../src/shared/search';
import type { SyncArticle } from '../src/shared/types';

const directory = await mkdtemp(join(tmpdir(), 'fragment-view-demo-'));
const webRoot = join(directory, 'web');
const build = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', webRoot], { stdio: 'inherit' });
if (build.status !== 0) throw new Error('Web UI build failed');
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true, script: 'export default { fetch() { return new Response("demo") } }',
  d1Databases: ['DB'], r2Buckets: ['BUCKET'],
}));
const database = await mf.getD1Database('DB');
const bucket = await mf.getR2Bucket('BUCKET');
await database.exec((await readFile('migrations/0001_initial.sql', 'utf8')).replace(/\n/g, ' '));
const db: Database = { async query<T>(sql: string, params: unknown[] = []) {
  const result = await database.prepare(sql).bind(...params).all();
  return { results: result.results as T[], changes: result.meta.changes };
} };
const image = await sharp({ create: { width: 800, height: 500, channels: 3, background: '#5865f2' } }).png().toBuffer();
const thumb = await sharp(image).resize({ width: 320 }).webp().toBuffer();
const imageId = createHash('sha256').update(image).digest('hex');
const topics = ['日々のメモ', 'アイデア', '開発'];
const articles: SyncArticle[] = Array.from({ length: 125 }, (_, i) => {
  const folder = topics[i % topics.length];
  const body = i === 0
    ? 'スマホで読むための **Fragment View** デモです。\n\n- フォルダをチャンネルとして表示\n- 日本語で全文検索\n- 画像は小さなサムネイルから\n\n' + '長い本文も、続きを開いたときだけ取得します。\n\n'.repeat(100)
    : `# ${folder}\n\n今日の記録 ${i + 1}。気づいたことや考えたことを少しずつ残す。\n\n日本語検索、タグ、チャンネルの組み合わせを試せます。`;
  const title = i === 0 ? 'ようこそ、Fragment Viewへ' : `${folder}の記録 ${i + 1}`;
  const text = normalizeSearch(`${title}\n${body}`);
  return {
    id: createHash('sha256').update(String(i)).digest('hex'), path: `active/${folder}/${i}.md`,
    area: i < 120 ? 'active' : 'archive', folder, title,
    createdAt: new Date(Date.UTC(2026, 8, 29, 12) - i * 3600_000).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 8, 29, 12) - i * 3600_000).toISOString(),
    body, tags: i % 2 === 0 ? ['メモ', 'アイデア'] : ['開発'], hash: String(i), searchText: text, searchTokens: searchTokens(text),
    attachments: i === 0 ? [{ id: imageId, name: 'demo.png', sourcePath: 'assets/demo.png', mime: 'image/png', size: image.length,
      originalKey: `originals/${imageId}`, thumbnailKey: `thumbs/${imageId}.webp` }] : [],
  };
});
await syncVault({ articles, objects: [
  { key: `originals/${imageId}`, bytes: image, mime: 'image/png' },
  { key: `thumbs/${imageId}.webp`, bytes: thumb, mime: 'image/webp' },
] }, { db, objects: { head: async key => !!await bucket.head(key), put: async (key, bytes, mime) => { await bucket.put(key, bytes, { httpMetadata: { contentType: mime } }); } },
  isAncestor: async () => true }, { commitSha: 'demo', apply: true });

const mimeTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const env: Env = {
  DB: database as unknown as D1Database, BUCKET: bucket as unknown as R2Bucket,
  LOCAL_DEV: 'true', ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '', ALLOWED_EMAIL: '',
  ASSETS: { async fetch(request: Request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    const file = resolve(webRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(webRoot + sep)) return new Response('Not found', { status: 404 });
    try { return new Response(await readFile(file), { headers: { 'Content-Type': mimeTypes[extname(file)] ?? 'application/octet-stream' } }); }
    catch { return new Response('Not found', { status: 404 }); }
  } } as unknown as Fetcher,
};
const server = createServer(async (incoming, outgoing) => {
  try {
    const response = await handleRequest(new Request(`http://127.0.0.1:8787${incoming.url ?? '/'}`, { method: incoming.method }), env);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    if (response.body) Readable.fromWeb(response.body as import('node:stream/web').ReadableStream).pipe(outgoing);
    else outgoing.end();
  } catch { outgoing.writeHead(500).end('Preview failed'); }
});
server.listen(8787, '127.0.0.1', () => console.log('Synthetic demo: http://127.0.0.1:8787 (Ctrl+C to stop)'));
async function close() { server.close(); await mf.dispose(); process.exit(0); }
process.on('SIGINT', close);
process.on('SIGTERM', close);
