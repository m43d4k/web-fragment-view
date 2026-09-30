import { randomUUID } from 'node:crypto';
import type { SyncArticle } from '../../src/shared/types';

export interface Database {
  query<T>(sql: string, params?: unknown[]): Promise<{ results: T[]; changes: number }>;
}

export interface ObjectStore {
  head(key: string): Promise<boolean>;
  put(key: string, bytes: Uint8Array, mime: string): Promise<void>;
  list?(prefix: string): AsyncIterable<{ key: string; lastModified: Date; size: number }>;
  delete?(key: string): Promise<void>;
}

export interface SyncSnapshot {
  articles: SyncArticle[];
  objects: { key: string; bytes: Uint8Array; mime: string }[];
}

export interface SyncOptions {
  commitSha: string;
  apply?: boolean;
  allowEmpty?: boolean;
  maxArticles?: number;
  gc?: boolean;
}

export interface SyncSummary {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  uploaded: number;
  uploadBytes: number;
  gcCandidates: number;
  gcBytes: number;
  gcDeleted: number;
}

interface Dependencies {
  db: Database;
  objects: ObjectStore;
  isAncestor(previousCommit: string, targetCommit: string): Promise<boolean>;
}

type State = { commit_sha: string | null; target_commit_sha: string | null };
type ManifestRow = { id: string; hash: string };
const LEASE_MS = 120_000;
const MAINTENANCE_LOCK_UNTIL = '9999-12-31T23:59:59.999Z';
const PAGE_SIZE = 500;
const GC_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const OWNED_PREFIXES = ['originals/', 'thumbs/'] as const;

function nowIso(): string { return new Date().toISOString(); }
function leaseUntil(): string { return new Date(Date.now() + LEASE_MS).toISOString(); }

async function loadState(db: Database): Promise<State> {
  const result = await db.query<State>('SELECT commit_sha, target_commit_sha FROM sync_state WHERE id = 1');
  if (result.results.length !== 1) throw new Error('sync_state row is missing');
  return result.results[0];
}

async function loadManifest(db: Database, refresh?: () => Promise<void>): Promise<Map<string, string>> {
  const manifest = new Map<string, string>();
  let after = '';
  for (;;) {
    await refresh?.();
    const page = await db.query<ManifestRow>(
      'SELECT id, hash FROM articles WHERE id > ? ORDER BY id LIMIT ?', [after, PAGE_SIZE]);
    for (const row of page.results) manifest.set(row.id, row.hash);
    if (page.results.length < PAGE_SIZE) return manifest;
    after = page.results.at(-1)!.id;
  }
}

function validateSnapshot(snapshot: SyncSnapshot, options: SyncOptions): void {
  if (!snapshot.articles.length && !options.allowEmpty) {
    throw new Error('empty vault snapshot; pass --allow-empty only for an intentional empty vault');
  }
  const limit = options.maxArticles ?? 1000;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('maxArticles must be a positive integer');
  if (options.apply && snapshot.articles.length > limit) {
    throw new Error(`vault has ${snapshot.articles.length} articles, above --max-articles ${limit}`);
  }
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const article of snapshot.articles) {
    if (ids.has(article.id) || paths.has(article.path)) throw new Error('duplicate article id or path in vault snapshot');
    ids.add(article.id);
    paths.add(article.path);
  }
  const keys = new Set<string>();
  for (const object of snapshot.objects) {
    if (keys.has(object.key)) throw new Error('duplicate object key in vault snapshot');
    keys.add(object.key);
  }
}

async function plan(snapshot: SyncSnapshot, dependencies: Dependencies, manifest: Map<string, string>, refresh?: () => Promise<void>) {
  const { objects } = dependencies;
  const created: SyncArticle[] = [];
  const updated: SyncArticle[] = [];
  let unchanged = 0;
  const currentIds = new Set<string>();
  const objectData = new Map(snapshot.objects.map((object) => [object.key, object]));
  const referencedKeys = new Set<string>();
  for (const article of snapshot.articles) {
    currentIds.add(article.id);
    const oldHash = manifest.get(article.id);
    if (oldHash === undefined) created.push(article);
    else if (oldHash !== article.hash) updated.push(article);
    else unchanged++;
    for (const attachment of article.attachments) {
      referencedKeys.add(attachment.originalKey);
      if (attachment.thumbnailKey) referencedKeys.add(attachment.thumbnailKey);
    }
  }
  const deleted = [...manifest.keys()].filter((id) => !currentIds.has(id));
  const uploads: NonNullable<SyncSnapshot['objects'][number]>[] = [];
  for (const key of referencedKeys) {
    await refresh?.();
    if (!(await objects.head(key))) {
      const object = objectData.get(key);
      if (!object) throw new Error(`required object has no bytes in snapshot: ${key}`);
      uploads.push(object);
    }
  }
  return { created, updated, deleted, unchanged, uploads };
}

function summarize(p: Awaited<ReturnType<typeof plan>>): SyncSummary {
  return {
    created: p.created.length, updated: p.updated.length, deleted: p.deleted.length,
    unchanged: p.unchanged, uploaded: p.uploads.length,
    uploadBytes: p.uploads.reduce((sum, item) => sum + item.bytes.byteLength, 0),
    gcCandidates: 0, gcBytes: 0, gcDeleted: 0,
  };
}

async function planGarbage(snapshot: SyncSnapshot, objects: ObjectStore, refresh?: () => Promise<void>) {
  if (!objects.list || !objects.delete) throw new Error('object store does not support garbage collection');
  const referenced = new Set<string>();
  for (const article of snapshot.articles) {
    for (const attachment of article.attachments) {
      referenced.add(attachment.originalKey);
      if (attachment.thumbnailKey) referenced.add(attachment.thumbnailKey);
    }
  }
  const cutoff = Date.now() - GC_AGE_MS;
  const garbage: { key: string; size: number }[] = [];
  for (const prefix of OWNED_PREFIXES) {
    await refresh?.();
    for await (const object of objects.list(prefix)) {
      await refresh?.();
      if (!object.key.startsWith(prefix)) throw new Error('object store returned a key outside the requested prefix');
      if (object.lastModified.getTime() < cutoff && !referenced.has(object.key)) {
        garbage.push({ key: object.key, size: object.size });
      }
    }
  }
  return garbage;
}

const UPSERT_SQL = `INSERT INTO articles
  (id, path, area, folder, title, created_at, updated_at, body, tags_json, attachments_json, hash, search_text, search_tokens)
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  WHERE EXISTS (SELECT 1 FROM sync_state WHERE id = 1 AND lock_owner = ? AND lock_until > ?)
  ON CONFLICT(id) DO UPDATE SET
    path = excluded.path, area = excluded.area, folder = excluded.folder,
    title = excluded.title, created_at = excluded.created_at, updated_at = excluded.updated_at,
    body = excluded.body, tags_json = excluded.tags_json,
    attachments_json = excluded.attachments_json, hash = excluded.hash,
    search_text = excluded.search_text, search_tokens = excluded.search_tokens
  RETURNING id`;

async function writeArticle(db: Database, article: SyncArticle, owner: string) {
  const result = await db.query(UPSERT_SQL, [
    article.id, article.path, article.area, article.folder, article.title,
    article.createdAt, article.updatedAt, article.body, JSON.stringify(article.tags),
    JSON.stringify(article.attachments), article.hash, article.searchText, article.searchTokens,
    owner, nowIso(),
  ]);
  if (result.results.length !== 1 || (result.results[0] as { id?: string }).id !== article.id) {
    throw new Error('sync lease lost while writing article');
  }
}

export async function syncVault(snapshot: SyncSnapshot, dependencies: Dependencies, options: SyncOptions): Promise<SyncSummary> {
  validateSnapshot(snapshot, options);
  const { db, objects, isAncestor } = dependencies;
  const owner = randomUUID();
  let locked = false;
  async function refresh() {
    const result = await db.query(
      'UPDATE sync_state SET lock_until = ? WHERE id = 1 AND lock_owner = ? AND lock_until > ?',
      [options.gc ? MAINTENANCE_LOCK_UNTIL : leaseUntil(), owner, nowIso()]);
    if (result.changes !== 1) throw new Error('sync lease lost');
  }
  try {
    if (options.apply) {
      const result = await db.query(
        'UPDATE sync_state SET lock_owner = ?, lock_until = ? WHERE id = 1 AND (lock_owner IS NULL OR lock_until <= ?)',
        [owner, options.gc ? MAINTENANCE_LOCK_UNTIL : leaseUntil(), nowIso()]);
      if (result.changes !== 1) {
        throw new Error('sync lock is held by another run; an interrupted --gc run requires manual recovery after confirming it stopped');
      }
      locked = true;
    }
    const state = await loadState(db);
    for (const previous of new Set([state.commit_sha, state.target_commit_sha])) {
      if (previous && !(await isAncestor(previous, options.commitSha))) {
        throw new Error('stale target commit cannot replace a completed or attempted sync');
      }
    }
    const manifest = await loadManifest(db, options.apply ? refresh : undefined);
    const changes = await plan(snapshot, dependencies, manifest, options.apply ? refresh : undefined);
    const summary = summarize(changes);
    const garbage = options.gc ? await planGarbage(snapshot, objects, options.apply ? refresh : undefined) : [];
    summary.gcCandidates = garbage.length;
    summary.gcBytes = garbage.reduce((sum, item) => sum + item.size, 0);
    if (!options.apply) return summary;

    await refresh();
    const pinned = await db.query<{ id: number }>(
      'UPDATE sync_state SET target_commit_sha = ? WHERE id = 1 AND lock_owner = ? AND lock_until > ? RETURNING id',
      [options.commitSha, owner, nowIso()]);
    if (pinned.results.length !== 1 || pinned.results[0].id !== 1) throw new Error('sync lease lost while recording target');

    for (const object of changes.uploads) {
      await refresh();
      // Keys are content addressed, so a concurrent retry can safely upload identical bytes.
      await objects.put(object.key, object.bytes, object.mime);
    }
    for (const article of [...changes.created, ...changes.updated]) {
      await refresh();
      await writeArticle(db, article, owner);
    }
    for (const id of changes.deleted) {
      await refresh();
      const result = await db.query(
        'DELETE FROM articles WHERE id = ? AND EXISTS (SELECT 1 FROM sync_state WHERE id = 1 AND lock_owner = ? AND lock_until > ?) RETURNING id',
        [id, owner, nowIso()]);
      if (result.results.length !== 1 || (result.results[0] as { id?: string }).id !== id) {
        throw new Error('sync lease lost while deleting article');
      }
    }
    for (const object of garbage) {
      await refresh();
      await objects.delete!(object.key);
      summary.gcDeleted++;
    }
    await refresh();
    const committed = await db.query(
      'UPDATE sync_state SET commit_sha = ?, target_commit_sha = ?, completed_at = ? WHERE id = 1 AND lock_owner = ? AND lock_until > ?',
      [options.commitSha, options.commitSha, nowIso(), owner, nowIso()]);
    if (committed.changes !== 1) throw new Error('sync lease lost while recording commit');
    return summary;
  } finally {
    if (locked) {
      await db.query('UPDATE sync_state SET lock_owner = NULL, lock_until = NULL WHERE id = 1 AND lock_owner = ?', [owner]);
    }
  }
}
