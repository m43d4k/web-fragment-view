import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { generateKeyPair, SignJWT } from 'jose';
import { handleRequest, type Env } from '../src/worker/index';
import { verifyAccess } from '../src/worker/auth';
import { normalizeSearch, searchTokens } from '../src/shared/search';

let mf: Miniflare;
let env: Env;
const allow = async () => {};
const request = (path: string, init?: RequestInit) => handleRequest(new Request('https://example.test' + path, init), env, allow);

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'], r2Buckets: ['BUCKET'] }));
  const db = await mf.getD1Database('DB');
  const sql = await readFile('migrations/0001_initial.sql', 'utf8');
  // exec supports complete CREATE TRIGGER statements when flattened onto one line.
  await db.exec(sql.replace(/\n/g, ' '));
  env = { DB: db as unknown as D1Database, BUCKET: await mf.getR2Bucket('BUCKET') as unknown as R2Bucket,
    ASSETS: { fetch: async () => new Response('private ui') } as unknown as Fetcher,
    ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com', ACCESS_AUD: 'test', ALLOWED_EMAIL: 'me@example.test' };
  for (let i = 0; i < 25; i++) {
    const body = (i === 0 ? '日本語の検索サンプル ' : 'メモ ') + '長い本文'.repeat(700);
    await db.prepare('INSERT INTO articles (id,path,area,folder,title,created_at,updated_at,body,tags_json,attachments_json,hash,search_text,search_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(String(i).padStart(4, '0'), `active/test/${i}.md`, 'active', 'test', `記事${i}`, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', body,
        JSON.stringify(i === 0 ? ['日本語'] : ['memo']), '[]', String(i), normalizeSearch(body), searchTokens(body)).run();
  }
});
afterAll(async () => { await mf?.dispose(); });

describe('read API', () => {
  it('scopes tag counts by area and optional folder, and binds paginated cursors to that scope', async () => {
    const db = env.DB;
    const fixtures = [
      ['tag-a', 'active', 'tag-scope', ['shared', 'only-a', 'wild%_tag']],
      ['tag-b', 'active', 'tag-scope', ['shared']],
      ['tag-c', 'active', 'elsewhere', ['shared', 'only-other']],
      ['tag-d', 'archive', 'tag-scope', ['shared', 'only-archive']],
    ] as const;
    try {
      for (const [id, area, folder, tags] of fixtures) {
        await db.prepare('INSERT INTO articles (id,path,area,folder,title,created_at,updated_at,body,tags_json,attachments_json,hash,search_text,search_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .bind(id, `${area}/${folder}/${id}.md`, area, folder, id, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', id,
            JSON.stringify(tags), '[]', id, id, id).run();
      }
      const scoped = await (await request('/api/tags?area=active&folder=tag-scope')).json() as any;
      expect(scoped.items).toEqual([{ name: 'only-a', count: 1, available: true }, { name: 'shared', count: 2, available: true }, { name: 'wild%_tag', count: 1, available: true }]);
      const matches = await (await request('/api/tags?area=active&folder=tag-scope&q=only')).json() as any;
      expect(matches.items).toEqual([{ name: 'only-a', count: 1, available: true }]);
      const literalWildcard = await (await request('/api/tags?area=active&folder=tag-scope&q=%25_')).json() as any;
      expect(literalWildcard.items).toEqual([{ name: 'wild%_tag', count: 1, available: true }]);
      const all = await (await request('/api/tags?area=active')).json() as any;
      expect(all.items).toContainEqual({ name: 'only-other', count: 1, available: true });
      expect(all.items.find((item: any) => item.name === 'shared').count).toBe(3);
      const empty = await (await request('/api/tags?area=active&folder=missing-folder')).json() as any;
      expect(empty.items).toEqual([]);

      const many = Array.from({ length: 52 }, (_, i) => `page-${String(i).padStart(2, '0')}`);
      await db.prepare('INSERT INTO articles (id,path,area,folder,title,created_at,updated_at,body,tags_json,attachments_json,hash,search_text,search_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .bind('tag-pages', 'active/tag-pages/article.md', 'active', 'tag-pages', 'pages', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', 'pages', JSON.stringify(many), '[]', 'tag-pages', 'pages', 'pages').run();
      const first = await (await request('/api/tags?area=active&folder=tag-pages')).json() as any;
      expect(first.items).toHaveLength(50);
      expect(first.nextCursor).toBeTruthy();
      const cursor = encodeURIComponent(first.nextCursor);
      const second = await (await request(`/api/tags?area=active&folder=tag-pages&cursor=${cursor}`)).json() as any;
      expect(second.items).toHaveLength(2);
      expect((await request(`/api/tags?area=active&folder=tag-scope&cursor=${cursor}`)).status).toBe(400);
      const filtered = await (await request('/api/tags?area=active&folder=tag-pages&q=page-')).json() as any;
      expect(filtered.items).toHaveLength(50);
      expect((await request(`/api/tags?area=active&folder=tag-pages&q=page-0&cursor=${encodeURIComponent(filtered.nextCursor)}`)).status).toBe(400);
    } finally {
      for (const [id] of fixtures) await db.prepare('DELETE FROM articles WHERE id = ?').bind(id).run();
      await db.prepare('DELETE FROM articles WHERE id = ?').bind('tag-pages').run();
    }
  });
  it('caps pages at 20 and follows a stable cursor without overlap', async () => {
    const response = await request('/api/articles?area=active&limit=999');
    expect(response.status).toBe(200);
    const first = await response.json() as any;
    expect(first.items).toHaveLength(20);
    expect(first.items[0].body.length).toBeLessThanOrEqual(2000);
    expect(first.items[0].truncated).toBe(true);
    const second = await (await request('/api/articles?area=active&cursor=' + encodeURIComponent(first.nextCursor))).json() as any;
    expect(second.items).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(25);
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it('uses full Tokyo calendar days at UTC boundaries, including one-sided ranges', async () => {
    const fixtures = [
      ['before', '2026-08-31T14:59:59.999Z'],
      ['start', '2026-08-31T15:00:00.000Z'],
      ['end', '2026-09-01T14:59:59.999Z'],
      ['after', '2026-09-01T15:00:00.000Z'],
    ] as const;
    try {
      for (const [id, createdAt] of fixtures) {
        await env.DB.prepare('INSERT INTO articles (id,path,area,folder,title,created_at,updated_at,body,tags_json,attachments_json,hash,search_text,search_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .bind(`date-${id}`, `active/date-boundary/${id}.md`, 'active', 'date-boundary', id, createdAt, createdAt,
            id, '[]', '[]', id, id, id).run();
      }
      const ids = async (filter: string) => (await (await request('/api/articles?folder=date-boundary' + filter)).json() as any)
        .items.map((item: any) => item.id);
      expect(await ids('&dateFrom=2026-09-01&dateTo=2026-09-01')).toEqual(['date-end', 'date-start']);
      expect(await ids('&dateFrom=2026-09-01')).toEqual(['date-after', 'date-end', 'date-start']);
      expect(await ids('&dateTo=2026-09-01')).toEqual(['date-end', 'date-start', 'date-before']);
      expect(await ids('&dateFrom=&dateTo=')).toEqual(['date-after', 'date-end', 'date-start', 'date-before']);
    } finally {
      for (const [id] of fixtures) await env.DB.prepare('DELETE FROM articles WHERE id = ?').bind(`date-${id}`).run();
    }
  });
  it('rejects malformed and reversed date ranges', async () => {
    for (const filter of ['dateFrom=2026-9-01', 'dateTo=2026-02-29', 'dateFrom=1900-02-29',
      'dateFrom=0000-01-01', 'dateTo=10000-01-01', 'dateTo=2026-13-01', 'dateFrom=2026-09-02&dateTo=2026-09-01']) {
      expect((await request('/api/articles?' + filter)).status).toBe(400);
    }
    expect((await request('/api/articles?dateFrom=2000-02-29&dateTo=2000-02-29')).status).toBe(200);
    expect((await request('/api/articles?dateFrom=0001-01-01&dateTo=9999-12-31')).status).toBe(200);
  });
  it('combines dates with server filters and binds paginated cursors to the range', async () => {
    const base = '/api/articles?area=active&folder=test&tag=memo&q=' + encodeURIComponent('メモ') + '&dateFrom=2026-09-01&dateTo=2026-09-01';
    const first = await (await request(base)).json() as any;
    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).toBeTruthy();
    const cursor = '&cursor=' + encodeURIComponent(first.nextCursor);
    const second = await (await request(base + cursor)).json() as any;
    expect(second.items).toHaveLength(4);
    expect(new Set([...first.items, ...second.items].map((item: any) => item.id)).size).toBe(24);
    expect((await request(base.replace('dateTo=2026-09-01', 'dateTo=2026-09-02') + cursor)).status).toBe(400);
    expect((await request(base.replace('dateFrom=2026-09-01', 'dateFrom=') + cursor)).status).toBe(400);
  });
  it('searches Japanese substrings and tags on the server', async () => {
    const response = await request('/api/articles?area=active&q=' + encodeURIComponent('語の検索') + '&tag=' + encodeURIComponent('日本語'));
    expect(response.status).toBe(200);
    const result = await response.json() as any;
    expect(result.items.map((item: any) => item.id)).toEqual(['0000']);
    const none = await (await request('/api/articles?q=' + encodeURIComponent('存在しない'))).json() as any;
    expect(none.items).toEqual([]);
  });
  it('combines multiple tags with AND by default or OR when requested', async () => {
    const and = await request('/api/articles?tag=memo&tag=日本語');
    expect((await and.json() as any).items).toEqual([]);
    const or = await request('/api/articles?tag=memo&tag=日本語&tagMode=OR');
    const first = await or.json() as any;
    expect(first.items).toHaveLength(20);
    const second = await (await request('/api/articles?tag=memo&tag=日本語&tagMode=OR&cursor=' + encodeURIComponent(first.nextCursor))).json() as any;
    expect(second.items).toHaveLength(5);
    expect(new Set([...first.items, ...second.items].map((item: any) => item.id)).size).toBe(25);
    const single = await (await request('/api/articles?tag=日本語&tagMode=OR')).json() as any;
    expect(single.items.map((item: any) => item.id)).toEqual(['0000']);
    const unfiltered = await (await request('/api/articles?tagMode=OR')).json() as any;
    expect(unfiltered.items).toHaveLength(20);
  });
  it('combines tags with area, folder, and search filters', async () => {
    const db = env.DB;
    const fixtures = [
      ['multi-a', 'active', 'special', ['alpha', 'beta'], '共通の話題'],
      ['multi-b', 'active', 'special', ['alpha'], '共通の話題'],
      ['multi-c', 'active', 'other', ['alpha', 'beta'], '共通の話題'],
      ['multi-d', 'archive', 'special', ['alpha', 'beta'], '共通の話題'],
      ['multi-e', 'active', 'special', ['alpha', 'beta'], '別の話題'],
    ] as const;
    try {
      for (const [id, area, folder, tags, body] of fixtures) {
        await db.prepare('INSERT INTO articles (id,path,area,folder,title,created_at,updated_at,body,tags_json,attachments_json,hash,search_text,search_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .bind(id, `${area}/${folder}/${id}.md`, area, folder, id, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', body,
            JSON.stringify(tags), '[]', id, normalizeSearch(body), searchTokens(body)).run();
      }
      const base = '/api/articles?area=active&folder=special&q=' + encodeURIComponent('共通');
      const and = await (await request(base + '&tag=alpha&tag=beta')).json() as any;
      expect(and.items.map((item: any) => item.id)).toEqual(['multi-a']);
      const or = await (await request(base + '&tag=alpha&tag=beta&tagMode=OR')).json() as any;
      expect(or.items.map((item: any) => item.id)).toEqual(['multi-b', 'multi-a']);
    } finally {
      for (const [id] of fixtures) await db.prepare('DELETE FROM articles WHERE id = ?').bind(id).run();
    }
  });
  it('normalizes tag order and duplicates in cursor scope, but rejects changed filters', async () => {
    const page = await (await request('/api/articles?tag=memo&tag=日本語&tagMode=OR')).json() as any;
    const cursor = '&cursor=' + encodeURIComponent(page.nextCursor);
    expect((await request('/api/articles?tag=日本語&tag=memo&tag=memo&tagMode=OR' + cursor)).status).toBe(200);
    expect((await request('/api/articles?tag=memo&tag=日本語' + cursor)).status).toBe(400);
    expect((await request('/api/articles?tag=memo&tag=日本語&tagMode=OR&folder=test' + cursor)).status).toBe(400);
    const memo = await (await request('/api/articles?tag=memo&tag=memo')).json() as any;
    expect(memo.items).toHaveLength(20);
    expect((await request('/api/articles?tag=memo&tagMode=AND&cursor=' + encodeURIComponent(memo.nextCursor))).status).toBe(200);
  });
  it('rejects empty, excessive, and overlong tags and unknown tag modes', async () => {
    for (const path of ['/api/articles?tag=', '/api/articles?tag=' + 'x'.repeat(101),
      '/api/articles?' + Array.from({ length: 65 }, () => 'tag=x').join('&'),
      '/api/articles?tagMode=XOR']) {
      expect((await request(path)).status).toBe(400);
    }
    for (const path of ['/api/tags?tag=', '/api/tags?tag=' + 'x'.repeat(101),
      '/api/tags?' + Array.from({ length: 65 }, () => 'tag=x').join('&'), '/api/tags?tagMode=XOR']) {
      expect((await request(path)).status).toBe(400);
    }
  });
  it('includes selected tags in tag search and marks unavailable AND combinations', async () => {
    const fixtures = [
      ['avail-ab', ['alpha', 'beta']], ['avail-ac', ['alpha', 'common']],
      ['avail-bc', ['beta', 'common']], ['avail-c', ['common']], ['avail-ghost', ['ghost']],
      ['avail-outside', ['alpha', 'ghost']],
    ] as const;
    try {
      for (const [id, tags] of fixtures) {
        await env.DB.prepare('INSERT INTO articles (id,path,area,folder,title,created_at,updated_at,body,tags_json,attachments_json,hash,search_text,search_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .bind(id, `active/${id === 'avail-outside' ? 'other-folder' : 'tag-availability'}/${id}.md`, 'active', id === 'avail-outside' ? 'other-folder' : 'tag-availability', id, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', id,
            JSON.stringify(tags), '[]', id, id, id).run();
      }
      const and = await (await request('/api/tags?area=active&folder=tag-availability&tag=alpha&q=%23common')).json() as any;
      expect(and.items).toEqual([
        { name: 'alpha', count: 2, available: true },
        { name: 'common', count: 3, available: true },
      ]);
      const selectedOnly = await (await request('/api/tags?area=active&folder=tag-availability&tag=alpha')).json() as any;
      expect(selectedOnly.items.map((tag: any) => tag.name)).toEqual(['alpha', 'beta', 'common', 'ghost']);
      expect(selectedOnly.items.find((tag: any) => tag.name === 'ghost').available).toBe(false);
      const andNoMatch = await (await request('/api/tags?area=active&folder=tag-availability&tag=alpha&tag=beta')).json() as any;
      expect(andNoMatch.items.find((tag: any) => tag.name === 'common').available).toBe(false);
      const or = await (await request('/api/tags?area=active&folder=tag-availability&tag=alpha&tag=beta&tagMode=OR')).json() as any;
      expect(or.items.every((tag: any) => tag.available === true)).toBe(true);

      const page = await (await request('/api/tags?area=active&folder=tag-availability')).json() as any;
      const cursor = encodeURIComponent(page.nextCursor);
      expect((await request(`/api/tags?area=active&folder=tag-availability&tag=alpha&cursor=${cursor}`)).status).toBe(400);
      expect((await request(`/api/tags?area=active&folder=tag-availability&tag=alpha&tagMode=OR&cursor=${cursor}`)).status).toBe(400);
    } finally {
      for (const [id] of fixtures) await env.DB.prepare('DELETE FROM articles WHERE id = ?').bind(id).run();
    }
  });
  it('does not interpret query text as SQL or FTS syntax', async () => {
    const response = await request('/api/articles?q=' + encodeURIComponent('" OR 1=1 --'));
    expect(response.status).toBe(200);
    expect((await response.json() as any).items).toEqual([]);
  });
  it('rejects a cursor reused for another filter or after a mutation', async () => {
    const page = await (await request('/api/articles')).json() as any;
    expect((await request('/api/articles?tag=memo&cursor=' + encodeURIComponent(page.nextCursor))).status).toBe(400);
    await env.DB.prepare('UPDATE articles SET title = ? WHERE id = ?').bind('変更', '0001').run();
    expect((await request('/api/articles?cursor=' + encodeURIComponent(page.nextCursor))).status).toBe(409);
  });
  it('protects UI, API and attachment requests before accessing data', async () => {
    for (const path of ['/', '/api/articles', '/api/assets/abc?variant=original']) {
      const response = await handleRequest(new Request('https://example.test' + path), env);
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain('private ui');
    }
  });
  it('accepts only a signed Access token for the configured audience and email', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const signed = (email: string, audience = env.ACCESS_AUD, expiresAt = Math.floor(Date.now() / 1000) + 300) =>
      new SignJWT({ email }).setProtectedHeader({ alg: 'RS256' })
        .setIssuer(`https://${env.ACCESS_TEAM_DOMAIN}`).setAudience(audience).setSubject('identity')
        .setIssuedAt().setExpirationTime(expiresAt).sign(privateKey);
    const verify = (token: string) => verifyAccess(new Request('https://example.test/', {
      headers: { 'Cf-Access-Jwt-Assertion': token },
    }), env, async () => publicKey);
    await expect(verify(await signed(env.ALLOWED_EMAIL))).resolves.toBeUndefined();
    await expect(verify(await signed('other@example.test'))).rejects.toMatchObject({ status: 401 });
    await expect(verify(await signed(env.ALLOWED_EMAIL, 'wrong-audience'))).rejects.toMatchObject({ status: 401 });
    await expect(verify(await signed(env.ALLOWED_EMAIL, env.ACCESS_AUD, Math.floor(Date.now() / 1000) - 10)))
      .rejects.toMatchObject({ status: 401 });
  });
  it('returns 404 for unreferenced attachments, and rejects invalid filters', async () => {
    expect((await request('/api/assets/unused?variant=original')).status).toBe(404);
    expect((await request('/api/articles?area=unknown')).status).toBe(400);
    expect((await request('/api/articles?cursor=garbage')).status).toBe(400);
  });
  it('serves only referenced originals and thumbnails, supports ranges, and revokes deleted references', async () => {
    const db = env.DB;
    const bucket = env.BUCKET;
    const attachment = {
      id: 'asset-1', name: 'note.txt', sourcePath: 'assets/note.txt', mime: 'text/plain', size: 8,
      originalKey: 'originals/asset-1', thumbnailKey: 'thumbs/asset-1.webp',
    };
    await bucket.put(attachment.originalKey, 'ABCDEFGH', { httpMetadata: { contentType: 'text/plain' } });
    await bucket.put(attachment.thumbnailKey, 'thumbnail', { httpMetadata: { contentType: 'image/webp' } });
    // An R2 object alone must not make an asset visible through the API.
    expect((await request('/api/assets/asset-1?variant=original')).status).toBe(404);
    await db.prepare('INSERT INTO articles (id,path,area,folder,title,created_at,updated_at,body,tags_json,attachments_json,hash,search_text,search_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind('asset-article', 'active/test/asset.md', 'active', 'test', 'asset', '2026-09-01T00:00:00.000Z',
        '2026-09-01T00:00:00.000Z', 'asset', '[]', JSON.stringify([attachment]), 'asset', 'asset', 'asset').run();

    const original = await request('/api/assets/asset-1?variant=original');
    expect(original.status).toBe(200);
    expect(original.headers.get('content-type')).toBe('text/plain');
    expect(original.headers.get('content-disposition')).toContain('attachment');
    expect(original.headers.get('cache-control')).toContain('no-store');
    expect(await original.text()).toBe('ABCDEFGH');
    const metadataOnly = await handleRequest(new Request('https://example.test/api/assets/asset-1?variant=original',
      { method: 'HEAD' }), { ...env, BUCKET: {
      head: (key: string) => bucket.head(key),
      get: () => { throw new Error('HEAD fetched the object body'); },
    } as unknown as R2Bucket }, allow);
    expect(metadataOnly.status).toBe(200);
    expect(metadataOnly.headers.get('content-length')).toBe('8');
    expect(await metadataOnly.text()).toBe('');
    const thumbnail = await request('/api/assets/asset-1?variant=thumbnail');
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get('content-type')).toBe('image/webp');
    expect(thumbnail.headers.get('content-disposition')).toContain('inline');
    expect(await thumbnail.text()).toBe('thumbnail');

    const partial = await request('/api/assets/asset-1?variant=original', { headers: { Range: 'bytes=2-4' } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe('bytes 2-4/8');
    expect(await partial.text()).toBe('CDE');
    const unsatisfiable = await request('/api/assets/asset-1?variant=original', { headers: { Range: 'bytes=100-200' } });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get('content-range')).toBe('bytes */8');
    expect((await request('/api/assets/asset-1?variant=original', { headers: { Range: 'bytes=4-2' } })).status).toBe(416);

    await db.prepare('DELETE FROM articles WHERE id = ?').bind('asset-article').run();
    expect((await request('/api/assets/asset-1?variant=original')).status).toBe(404);
    expect((await request('/api/assets/asset-1?variant=thumbnail')).status).toBe(404);
  });
});
