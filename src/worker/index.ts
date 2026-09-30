import type { Article, Attachment } from '../shared/types';
import { searchQuery } from '../shared/search';
import { HttpError, verifyAccess, type AuthEnv } from './auth';

export interface Env extends AuthEnv { DB: D1Database; BUCKET: R2Bucket; ASSETS: Fetcher }
type Row = Record<string, any>;
type Cursor = { revision: number; scope: string; after: string[] };
const json = (data: unknown, status = 200) => Response.json(data, { status });
const invalid = (message: string): never => { throw new HttpError(400, 'INVALID_REQUEST', message); };

function encodeCursor(cursor: Cursor): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(cursor))));
}

function decodeCursor(value: string | null, scope: string): Cursor | null {
  if (!value) return null;
  try {
    if (value.length > 4096) return invalid('カーソルが不正です。');
    const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value), c => c.charCodeAt(0))));
    if (!Number.isSafeInteger(parsed.revision) || parsed.scope !== scope || !Array.isArray(parsed.after) ||
      parsed.after.length > 2 || !parsed.after.every((part: unknown) => typeof part === 'string' && part.length <= 1024)) {
      return invalid('カーソルが不正です。');
    }
    return parsed;
  } catch { return invalid('カーソルが不正です。'); }
}

function areaFrom(url: URL): string {
  const area = url.searchParams.get('area') ?? 'active';
  if (area !== 'active' && area !== 'archive') return invalid('表示範囲が不正です。');
  return area;
}

function articleFrom(row: Row): Article {
  return {
    id: row.id, path: row.path, area: row.area, folder: row.folder, title: row.title,
    createdAt: row.created_at, updatedAt: row.updated_at, body: row.body,
    tags: JSON.parse(row.tags_json), attachments: JSON.parse(row.attachments_json), truncated: !!row.truncated,
  };
}

// A read batch gives metadata and the page from one transaction.
async function readPage(db: D1Database, sql: string, params: unknown[], cursor: Cursor | null): Promise<{rows: Row[]; revision: number}> {
  const result = await db.batch([
    db.prepare('SELECT revision FROM sync_state WHERE id = 1'),
    db.prepare(sql).bind(...params),
  ]);
  const revision = (result[0].results[0] as Row)?.revision;
  if (!Number.isSafeInteger(revision)) throw new Error('Missing sync state');
  if (cursor && cursor.revision !== revision) throw new HttpError(409, 'REVISION_CHANGED', '記事が更新されました。一覧を再読み込みしてください。');
  return { rows: result[1].results as Row[], revision };
}

async function listArticles(url: URL, env: Env): Promise<Response> {
  const area = areaFrom(url);
  const folder = url.searchParams.get('folder');
  const rawTags = url.searchParams.getAll('tag');
  const tagMode = url.searchParams.get('tagMode') ?? 'AND';
  const q = url.searchParams.get('q') ?? '';
  if ((folder?.length ?? 0) > 512 || rawTags.length > 64 || rawTags.some(tag => tag.length < 1 || tag.length > 100))
    return invalid('絞り込み条件が不正です。');
  if (tagMode !== 'AND' && tagMode !== 'OR') return invalid('タグの絞り込み方法が不正です。');
  const tags = [...new Set(rawTags)].sort();
  let search: ReturnType<typeof searchQuery>;
  try { search = searchQuery(q); } catch (error) { return invalid((error as Error).message); }
  const scope = JSON.stringify(['articles', area, folder, tags, tagMode, q]);
  const cursor = decodeCursor(url.searchParams.get('cursor'), scope);
  if (cursor && cursor.after.length !== 2) return invalid('カーソルが不正です。');
  const where = ['a.area = ?'];
  const params: unknown[] = [area];
  if (folder !== null) { where.push('a.folder = ?'); params.push(folder); }
  if (tags.length) {
    const placeholders = tags.map(() => '?').join(',');
    if (tagMode === 'AND') {
      where.push(`a.id IN (SELECT article_id FROM article_tags WHERE tag IN (${placeholders}) GROUP BY article_id HAVING count(*) = ?)`);
      params.push(...tags, tags.length);
    } else {
      where.push(`a.id IN (SELECT article_id FROM article_tags WHERE tag IN (${placeholders}))`);
      params.push(...tags);
    }
  }
  if (search.match) {
    where.push('a.id IN (SELECT id FROM articles_fts WHERE articles_fts MATCH ?)');
    params.push(search.match);
    // Gram matches are candidates; verify each literal term to avoid false positives.
    for (const term of search.terms) { where.push('instr(a.search_text, ?) > 0'); params.push(term); }
  }
  if (cursor) { where.push('(a.created_at, a.id) < (?, ?)'); params.push(...cursor.after); }
  const { rows, revision } = await readPage(env.DB, `SELECT a.id,a.path,a.area,a.folder,a.title,a.created_at,a.updated_at,
    substr(a.body,1,2000) AS body,length(a.body)>2000 AS truncated,a.tags_json,a.attachments_json
    FROM articles a WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC,a.id DESC LIMIT 21`, params, cursor);
  const items = rows.slice(0, 20).map(articleFrom);
  const last = items.at(-1);
  return json({ items, revision, nextCursor: rows.length > 20 && last ? encodeCursor({ revision, scope, after: [last.createdAt, last.id] }) : null });
}

async function metadata(url: URL, env: Env, kind: 'channels' | 'tags'): Promise<Response> {
  const area = areaFrom(url);
  const folder = kind === 'tags' ? url.searchParams.get('folder') : null;
  if ((folder?.length ?? 0) > 512) return invalid('絞り込み条件が不正です。');
  const scope = JSON.stringify(kind === 'tags' ? [kind, area, folder] : [kind, area]);
  const cursor = decodeCursor(url.searchParams.get('cursor'), scope);
  if (cursor && cursor.after.length !== 1) return invalid('カーソルが不正です。');
  const after = cursor?.after[0] ?? '';
  const sql = kind === 'channels'
    ? 'SELECT folder,area,count(*) AS count FROM articles WHERE area=? AND folder>? GROUP BY folder,area ORDER BY folder LIMIT 51'
    : `SELECT t.tag AS name,count(*) AS count FROM article_tags t JOIN articles a ON a.id=t.article_id
      WHERE a.area=?${folder === null ? '' : ' AND a.folder=?'} AND t.tag>? GROUP BY t.tag ORDER BY t.tag LIMIT 51`;
  const params = kind === 'channels' ? [area, after] : folder === null ? [area, after] : [area, folder, after];
  const { rows, revision } = await readPage(env.DB, sql, params, cursor);
  const items = rows.slice(0, 50);
  const last = items.at(-1);
  return json({ items, revision, nextCursor: rows.length > 50 && last ? encodeCursor({ revision, scope, after: [last[kind === 'channels' ? 'folder' : 'name']] }) : null });
}

async function asset(request: Request, url: URL, env: Env, id: string): Promise<Response> {
  const variant = url.searchParams.get('variant') ?? 'thumbnail';
  if (!['thumbnail', 'original'].includes(variant)) return invalid('添付の種類が不正です。');
  const row = await env.DB.prepare('SELECT metadata FROM article_assets WHERE id = ? LIMIT 1').bind(id).first<{metadata: string}>();
  if (!row) throw new HttpError(404, 'NOT_FOUND', '添付が見つかりません。');
  const attachment = JSON.parse(row.metadata) as Attachment;
  const key = variant === 'thumbnail' ? attachment.thumbnailKey : attachment.originalKey;
  if (!key) throw new HttpError(404, 'NOT_FOUND', 'サムネイルがありません。');
  const rangeHeader = request.headers.get('Range');
  const requestedRange = rangeHeader ? /^bytes=(?:(\d+)-(\d*)|-(\d+))$/.exec(rangeHeader) : null;
  if (rangeHeader && !requestedRange) throw new HttpError(416, 'RANGE_NOT_SATISFIABLE', '指定された範囲を取得できません。');
  const object = request.method === 'HEAD' ? await env.BUCKET.head(key)
    : rangeHeader ? await env.BUCKET.get(key, { range: request.headers }) : await env.BUCKET.get(key);
  if (!object) throw new HttpError(503, 'ASSET_MISSING', '添付を取得できません。同期状態を確認してください。');
  if (requestedRange) {
    const start = requestedRange[1] === undefined ? null : Number(requestedRange[1]);
    const end = requestedRange[2] ? Number(requestedRange[2]) : null;
    const suffix = requestedRange[3] === undefined ? null : Number(requestedRange[3]);
    if ((start !== null && (!Number.isSafeInteger(start) || start >= object.size)) ||
      (end !== null && (!Number.isSafeInteger(end) || end < start!)) ||
      (suffix !== null && (!Number.isSafeInteger(suffix) || suffix === 0))) {
      return Response.json({ error: '指定された範囲を取得できません。', code: 'RANGE_NOT_SATISFIABLE' },
        { status: 416, headers: { 'Content-Range': `bytes */${object.size}` } });
    }
  }
  const mime = variant === 'thumbnail' ? 'image/webp' : attachment.mime;
  const inline = /^image\/(png|jpeg|webp|gif|avif)$/.test(mime);
  const headers = new Headers({ 'Content-Type': mime, 'ETag': object.httpEtag, 'Accept-Ranges': 'bytes',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.name).replace(/['()]/g, c => '%' + c.charCodeAt(0).toString(16))}` });
  let status = 200;
  if (request.method !== 'HEAD' && rangeHeader && 'range' in object && object.range &&
    'offset' in object.range && 'length' in object.range &&
    typeof object.range.offset === 'number' && typeof object.range.length === 'number') {
    const { offset, length } = object.range;
    headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set('Content-Length', String(length));
    status = 206;
  } else headers.set('Content-Length', String(object.size));
  return new Response(request.method === 'HEAD' ? null : (object as R2ObjectBody).body, { status, headers });
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '閲覧専用です。');
  if (url.pathname === '/api/articles') return listArticles(url, env);
  if (url.pathname === '/api/channels') return metadata(url, env, 'channels');
  if (url.pathname === '/api/tags') return metadata(url, env, 'tags');
  const detail = /^\/api\/articles\/([a-zA-Z0-9_-]{1,128})$/.exec(url.pathname);
  if (detail) {
    const row = await env.DB.prepare('SELECT * FROM articles WHERE id = ?').bind(detail[1]).first<Row>();
    if (!row) throw new HttpError(404, 'NOT_FOUND', '記事が見つかりません。');
    return json(articleFrom(row));
  }
  const media = /^\/api\/assets\/([a-zA-Z0-9_-]{1,128})$/.exec(url.pathname);
  if (media) return asset(request, url, env, media[1]);
  if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'NOT_FOUND', 'ページが見つかりません。');
  return env.ASSETS.fetch(request);
}

export async function handleRequest(request: Request, env: Env, authenticate = verifyAccess): Promise<Response> {
  let response: Response;
  try {
    await authenticate(request, env);
    response = await route(request, env);
  } catch (error) {
    response = error instanceof HttpError
      ? json({ error: error.message, code: error.code }, error.status)
      : json({ error: 'データを取得できません。時間をおいて再試行してください。', code: 'UNAVAILABLE' }, 503);
  }
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers });
}

export default { fetch: (request: Request, env: Env) => handleRequest(request, env) };
