import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { SyncSnapshot } from './engine';

/** Local-only sizing. No note text or paths are included in the returned report. */
export function inspectSnapshot(snapshot: SyncSnapshot) {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(readFileSync(new URL('../../migrations/0001_initial.sql', import.meta.url), 'utf8'));
    const insert = db.prepare(`INSERT INTO articles
      (id,path,area,folder,title,created_at,updated_at,body,tags_json,attachments_json,hash,search_text,search_tokens)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    db.exec('BEGIN');
    for (const article of snapshot.articles) insert.run(
      article.id, article.path, article.area, article.folder, article.title,
      article.createdAt, article.updatedAt, article.body, JSON.stringify(article.tags),
      JSON.stringify(article.attachments), article.hash, article.searchText, article.searchTokens,
    );
    db.exec('COMMIT');
    const { page_count } = db.prepare('PRAGMA page_count').get() as { page_count: number };
    const { page_size } = db.prepare('PRAGMA page_size').get() as { page_size: number };
    const sumBytes = (prefix: string) => snapshot.objects.filter(item => item.key.startsWith(prefix)).reduce((total, item) => total + item.bytes.byteLength, 0);
    return {
      articles: snapshot.articles.length,
      active: snapshot.articles.filter(article => article.area === 'active').length,
      archive: snapshot.articles.filter(article => article.area === 'archive').length,
      channels: new Set(snapshot.articles.map(article => `${article.area}/${article.folder}`)).size,
      uniqueTags: new Set(snapshot.articles.flatMap(article => article.tags)).size,
      objects: snapshot.objects.length,
      originalBytes: sumBytes('originals/'),
      thumbnailBytes: sumBytes('thumbs/'),
      estimatedDatabaseBytes: page_count * page_size,
      databaseEstimate: 'Local SQLite including indexes; actual D1 usage may differ.',
    };
  } finally { db.close(); }
}
