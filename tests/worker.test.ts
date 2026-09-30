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
  it('searches Japanese substrings and tags on the server', async () => {
    const response = await request('/api/articles?area=active&q=' + encodeURIComponent('語の検索') + '&tag=' + encodeURIComponent('日本語'));
    expect(response.status).toBe(200);
    const result = await response.json() as any;
    expect(result.items.map((item: any) => item.id)).toEqual(['0000']);
    const none = await (await request('/api/articles?q=' + encodeURIComponent('存在しない'))).json() as any;
    expect(none.items).toEqual([]);
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
