import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { SyncArticle } from '../src/shared/types';
import { syncVault, type Database, type ObjectStore } from '../scripts/sync/engine';

function article(path: string, hash = 'v1'): SyncArticle {
  return {
    id: path, path, hash, area: 'active', folder: 'notes', title: path,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    body: 'body', tags: ['tag'], attachments: [], searchText: 'body', searchTokens: 'body',
  };
}

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  let writes = 0;
  let failAfter = Infinity;
  const db: Database = {
    async query<T>(sql: string, params: unknown[] = []) {
      const statement = sqlite.prepare(sql);
      if (/^\s*SELECT\b/i.test(sql)) return { results: statement.all(...params as []) as T[], changes: 0 };
      writes++;
      if (writes === failAfter) throw new Error('injected failure');
      if (/\bRETURNING\b/i.test(sql)) return { results: statement.all(...params as []) as T[], changes: 0 };
      return { results: [] as T[], changes: Number(statement.run(...params as []).changes) };
    },
  };
  const data = new Map<string, Uint8Array>();
  const objects: ObjectStore = {
    async head(key) { return data.has(key); },
    async put(key, bytes) { data.set(key, bytes); },
  };
  const run = (articles: SyncArticle[], commitSha: string, apply = true, allowEmpty = false) =>
    syncVault({ articles, objects: [] }, { db, objects, isAncestor: async () => true },
      { commitSha, apply, allowEmpty });
  const rows = () => sqlite.prepare('SELECT id, hash FROM articles ORDER BY id').all();
  const state = () => sqlite.prepare('SELECT commit_sha, lock_owner FROM sync_state WHERE id = 1').get() as {commit_sha: string | null, lock_owner: string | null};
  return { db, sqlite, run, rows, state, get writes() { return writes; }, set failAfter(value: number) { failAfter = value; } };
}

describe('sync engine', () => {
  it('plans without any writes and rejects an accidental empty snapshot', async () => {
    const f = fixture();
    const result = await f.run([article('active/notes/a.md')], 'a', false);
    expect(result.created).toBe(1);
    expect(f.writes).toBe(0);
    await expect(f.run([], 'a')).rejects.toThrow(/empty/i);
    expect(f.rows()).toEqual([]);
    const overLimit = { articles: [article('a'), article('b')], objects: [] };
    await syncVault(overLimit, { db: f.db, objects: { head: async () => true, put: async () => {} }, isAncestor: async () => true },
      { commitSha: 'a', maxArticles: 1 });
    await expect(syncVault(overLimit,
      { db: f.db, objects: { head: async () => true, put: async () => {} }, isAncestor: async () => true },
      { commitSha: 'a', apply: true, maxArticles: 1 })).rejects.toThrow(/max-articles/);
    expect(f.writes).toBe(0);
  });

  it('recovers from a failed partial run without duplicate tags or an early commit', async () => {
    const f = fixture();
    f.failAfter = 6;
    await expect(f.run([article('a'), article('b')], 'a')).rejects.toThrow('injected failure');
    expect(f.state().commit_sha).toBeNull();
    f.failAfter = Infinity;
    await f.run([article('a'), article('b')], 'a');
    expect(f.rows()).toEqual([{ id: 'a', hash: 'v1' }, { id: 'b', hash: 'v1' }]);
    expect(f.sqlite.prepare('SELECT * FROM article_tags').all()).toHaveLength(2);
    expect(f.state()).toEqual({ commit_sha: 'a', lock_owner: null });
  });

  it('rejects an older target after a newer target partially writes, then allows retry', async () => {
    const f = fixture();
    const objects = { head: async () => true, put: async () => {} };
    const order = ['a', 'b', 'c'];
    const isAncestor = async (previous: string, target: string) => order.indexOf(previous) <= order.indexOf(target);
    const run = (db: Database, articles: SyncArticle[], commitSha: string) =>
      syncVault({ articles, objects: [] }, { db, objects, isAncestor }, { commitSha, apply: true });
    await run(f.db, [article('a', 'a')], 'a');
    let articleWrites = 0;
    const failing: Database = {
      async query<T>(sql: string, params?: unknown[]) {
        if (sql.startsWith('INSERT INTO articles') && ++articleWrites === 2) throw new Error('injected failure');
        return f.db.query<T>(sql, params);
      },
    };
    await expect(run(failing, [article('a', 'c'), article('b', 'c')], 'c')).rejects.toThrow('injected failure');
    expect(f.state().commit_sha).toBe('a');
    expect((f.sqlite.prepare('SELECT target_commit_sha FROM sync_state WHERE id = 1').get() as { target_commit_sha: string }).target_commit_sha).toBe('c');
    await expect(run(f.db, [article('a', 'b')], 'b')).rejects.toThrow(/stale/i);
    expect(f.rows()).toEqual([{ id: 'a', hash: 'a' }, { id: 'b', hash: 'c' }]);
    await run(f.db, [article('a', 'c'), article('b', 'c')], 'c');
    expect(f.rows()).toEqual([{ id: 'a', hash: 'c' }, { id: 'b', hash: 'c' }]);
    expect(f.state().commit_sha).toBe('c');
  });

  it('models a move as an addition and deletion, and removes deleted articles', async () => {
    const f = fixture();
    await f.run([article('active/x/a.md')], 'a');
    const result = await f.run([article('archive/x/a.md')], 'b');
    expect(result.created).toBe(1);
    expect(result.deleted).toBe(1);
    expect(f.rows()).toEqual([{ id: 'archive/x/a.md', hash: 'v1' }]);
    await f.run([], 'c', true, true);
    expect(f.rows()).toEqual([]);
  });

  it('does not publish an article until its referenced object is uploaded', async () => {
    const f = fixture();
    const item = article('a');
    item.attachments = [{
      id: 'hash', name: 'image.png', sourcePath: 'assets/image.png', mime: 'image/png', size: 3,
      originalKey: 'originals/hash', thumbnailKey: null,
    }];
    const snapshot = { articles: [item], objects: [{ key: 'originals/hash', bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' }] };
    const failing = { head: async () => false, put: async () => { throw new Error('upload failed'); } };
    await expect(syncVault(snapshot, { db: f.db, objects: failing, isAncestor: async () => true },
      { commitSha: 'a', apply: true })).rejects.toThrow('upload failed');
    expect(f.rows()).toEqual([]);
    expect(f.state().commit_sha).toBeNull();
    const uploaded = new Set<string>();
    const working = {
      head: async (key: string) => uploaded.has(key),
      put: async (key: string) => { uploaded.add(key); },
    };
    await syncVault(snapshot, { db: f.db, objects: working, isAncestor: async () => true },
      { commitSha: 'a', apply: true });
    expect(f.rows()).toHaveLength(1);
  });

  it('collects only old, unreferenced objects under owned prefixes when explicitly requested', async () => {
    const f = fixture();
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const recent = new Date();
    const entries = new Map([
      ['originals/referenced', old], ['originals/unused', old],
      ['thumbs/recent.webp', recent], ['unowned/unused', old],
    ]);
    const item = article('a');
    item.attachments = [{
      id: 'referenced', name: 'x', sourcePath: 'assets/x', mime: 'image/png', size: 1,
      originalKey: 'originals/referenced', thumbnailKey: null,
    }];
    const objects: ObjectStore = {
      head: async (key) => entries.has(key),
      put: async () => {},
      async *list(prefix) {
        for (const [key, lastModified] of entries) if (key.startsWith(prefix)) yield { key, lastModified, size: 1 };
      },
      delete: async (key) => { entries.delete(key); },
    };
    const summary = await syncVault({ articles: [item], objects: [] },
      { db: f.db, objects, isAncestor: async () => true }, { commitSha: 'a', apply: true, gc: true });
    expect(summary.gcDeleted).toBe(1);
    expect([...entries.keys()]).toEqual(['originals/referenced', 'thumbs/recent.webp', 'unowned/unused']);
  });

  it('holds a non-expiring maintenance lock during GC and releases it after an error', async () => {
    const f = fixture();
    const otherObjects = { head: async () => true, put: async () => {} };
    const objects: ObjectStore = {
      ...otherObjects,
      async *list(prefix) {
        if (prefix === 'originals/') {
          yield { key: 'originals/unused', lastModified: new Date(Date.now() - 8 * 86_400_000), size: 1 };
        }
      },
      async delete() {
        const lock = f.sqlite.prepare('SELECT lock_until FROM sync_state WHERE id = 1').get() as { lock_until: string };
        expect(lock.lock_until).toBe('9999-12-31T23:59:59.999Z');
        await expect(syncVault({ articles: [article('a')], objects: [] },
          { db: f.db, objects: otherObjects, isAncestor: async () => true },
          { commitSha: 'b', apply: true })).rejects.toThrow(/lock is held/);
        throw new Error('garbage collection failed');
      },
    };
    await expect(syncVault({ articles: [article('a')], objects: [] },
      { db: f.db, objects, isAncestor: async () => true },
      { commitSha: 'a', apply: true, gc: true })).rejects.toThrow('garbage collection failed');
    expect(f.state()).toEqual({ commit_sha: null, lock_owner: null });
    await f.run([article('a')], 'a');
    expect(f.state().commit_sha).toBe('a');
  });

  it('rejects stale revisions and another owner’s lease', async () => {
    const f = fixture();
    await f.run([article('a')], 'b');
    await expect(syncVault({ articles: [article('a')], objects: [] },
      { db: f.db, objects: { head: async () => true, put: async () => {} }, isAncestor: async () => false },
      { commitSha: 'a', apply: true })).rejects.toThrow(/stale/i);
    f.sqlite.prepare("UPDATE sync_state SET lock_owner = 'other', lock_until = '9999-01-01T00:00:00.000Z' WHERE id = 1").run();
    await expect(f.run([article('a')], 'c')).rejects.toThrow(/lock/i);
  });

  it('fences an article write if the lease changes after its refresh', async () => {
    const f = fixture();
    const db: Database = {
      async query<T>(sql: string, params?: unknown[]) {
        if (sql.startsWith('INSERT INTO articles')) {
          f.sqlite.prepare("UPDATE sync_state SET lock_owner = 'other' WHERE id = 1").run();
        }
        return f.db.query<T>(sql, params);
      },
    };
    await expect(syncVault({ articles: [article('a')], objects: [] },
      { db, objects: { head: async () => true, put: async () => {} }, isAncestor: async () => true },
      { commitSha: 'a', apply: true })).rejects.toThrow(/lease lost/i);
    expect(f.rows()).toEqual([]);
    expect(f.state().commit_sha).toBeNull();
  });
});
