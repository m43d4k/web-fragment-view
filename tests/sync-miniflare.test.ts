import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { expect, it } from 'vitest';
import type { SyncArticle } from '../src/shared/types';
import { syncVault, type Database } from '../scripts/sync/engine';

function article(id: string, hash = 'v1'): SyncArticle {
  return {
    id, path: `active/notes/${id}.md`, area: 'active', folder: 'notes', title: id,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    body: hash, tags: ['tag'], attachments: [], searchText: hash, searchTokens: hash, hash,
  };
}

it('syncs against D1 trigger accounting and recovers from a partial run', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'],
  }));
  try {
    const database = await mf.getD1Database('DB');
    await database.exec((await readFile('migrations/0001_initial.sql', 'utf8')).replace(/\n/g, ' '));
    const db: Database = {
      async query<T>(sql: string, params: unknown[] = []) {
        const result = await database.prepare(sql).bind(...params).all();
        return { results: result.results as T[], changes: result.meta.changes };
      },
    };
    const objects = { head: async () => true, put: async () => {} };
    const dependencies = { db, objects, isAncestor: async () => true };
    let inserts = 0;
    const failing: Database = {
      async query<T>(sql: string, params?: unknown[]) {
        if (sql.startsWith('INSERT INTO articles') && ++inserts === 2) throw new Error('injected failure');
        return db.query<T>(sql, params);
      },
    };
    await expect(syncVault({ articles: [article('a'), article('b')], objects: [] },
      { ...dependencies, db: failing }, { commitSha: 'a', apply: true })).rejects.toThrow('injected failure');
    expect((await db.query<{ commit_sha: string | null }>('SELECT commit_sha FROM sync_state WHERE id = 1')).results[0].commit_sha).toBeNull();
    expect((await db.query<{ target_commit_sha: string }>('SELECT target_commit_sha FROM sync_state WHERE id = 1')).results[0].target_commit_sha).toBe('a');
    expect((await db.query('SELECT id FROM articles')).results).toHaveLength(1);

    const recovered = await syncVault({ articles: [article('a'), article('b')], objects: [] },
      dependencies, { commitSha: 'a', apply: true });
    expect(recovered).toMatchObject({ created: 1, unchanged: 1, deleted: 0 });
    expect((await db.query('SELECT article_id FROM article_tags')).results).toHaveLength(2);

    const updated = await syncVault({ articles: [article('a', 'v2'), article('b')], objects: [] },
      dependencies, { commitSha: 'b', apply: true });
    expect(updated.updated).toBe(1);
    expect((await db.query<{ hash: string }>('SELECT hash FROM articles WHERE id = ?', ['a'])).results[0].hash).toBe('v2');

    const deleted = await syncVault({ articles: [article('a', 'v2')], objects: [] },
      dependencies, { commitSha: 'c', apply: true });
    expect(deleted.deleted).toBe(1);
    expect((await db.query('SELECT id FROM articles')).results).toHaveLength(1);
    expect((await db.query<{ commit_sha: string }>('SELECT commit_sha FROM sync_state WHERE id = 1')).results[0].commit_sha).toBe('c');
  } finally {
    await mf.dispose();
  }
});
