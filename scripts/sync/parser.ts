import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { basename, join, posix, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { normalizeSearch, searchTokens } from '../../src/shared/search';
import type { Attachment, Area, SyncArticle } from '../../src/shared/types';
import type { SyncSnapshot } from './engine';

const MAX_BODY_BYTES = 256 * 1024;
const MAX_ASSET_BYTES = 100 * 1024 * 1024;
const MAX_ROW_BYTES = 1_800_000;

const IMAGE_MIME: Record<string, string> = {
  '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff',
};
const FILE_MIME: Record<string, string> = {
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
  '.json': 'application/json', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
  '.mid': 'audio/midi', '.midi': 'audio/midi',
};
const LINK = /(!?)\[([^\]\n]*)\]\(([^)]+)\)/g;
const FILENAME = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(?:_(\d{1,6}))?\.md$/;
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

// FragmentBox uses local datetime.now(); this vault's wall clock is Asia/Tokyo.
function createdAt(name: string): string {
  const match = FILENAME.exec(name);
  if (!match) throw new Error('invalid article filename timestamp');
  const [, year, month, day, hour, minute, second, micro = '0'] = match;
  const ms = Date.UTC(+year, +month - 1, +day, +hour - 9, +minute, +second, +micro.padEnd(6, '0').slice(0, 3));
  const wall = new Date(ms + 9 * 60 * 60 * 1000);
  if (wall.getUTCFullYear() !== +year || wall.getUTCMonth() + 1 !== +month || wall.getUTCDate() !== +day ||
      wall.getUTCHours() !== +hour || wall.getUTCMinutes() !== +minute || wall.getUTCSeconds() !== +second) {
    throw new Error('invalid article date timestamp');
  }
  return new Date(ms).toISOString();
}

function titleFrom(body: string): string {
  const lines = body.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) return '無題';
  if (/^https?:\/\/\S+$/i.test(lines[0]) && /^title:\s*\S/i.test(lines[1] ?? '')) {
    return lines[1].replace(/^title:\s*/i, '').slice(0, 200);
  }
  const first = lines.find(line => !line.startsWith('![')) ?? '';
  return first ? first.replace(/^#{1,6}\s+/, '').slice(0, 200) : '無題';
}

function updatedAt(root: string, path: string): string {
  let value: string;
  try {
    value = execFileSync('git', ['-C', root, 'log', '-1', '--format=%cI', '--', path], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch { throw new Error('cannot read Git history for article'); }
  if (!value || Number.isNaN(Date.parse(value))) throw new Error('article is missing Git commit time');
  return new Date(value).toISOString();
}

function assetName(reference: string, articlePath: string): string | null {
  if (/^[a-z][a-z\d+.-]*:/i.test(reference) || reference.startsWith('//') || reference.startsWith('#')) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(reference); }
  catch { throw new Error('invalid asset URL encoding'); }
  if (!/^(?:\.\.\/)+assets\/[^/\\]+$/.test(decoded) && !/^\/assets\/[^/\\]+$/.test(decoded)) {
    throw new Error('unsupported local link in article');
  }
  const name = basename(decoded);
  if (name === '.' || name === '..' || name.includes('\0') || name.includes('?') || name.includes('#')) {
    throw new Error('invalid asset name');
  }
  if (!decoded.startsWith('/assets/') && posix.normalize(posix.join(posix.dirname(articlePath), decoded)) !== 'assets/' + name) {
    throw new Error('asset link leaves the shared assets directory');
  }
  return name;
}

async function articlePaths(root: string): Promise<{ area: Area; folder: string; path: string }[]> {
  const result: { area: Area; folder: string; path: string }[] = [];
  for (const area of ['active', 'archive'] as const) {
    for (const folder of (await readdir(join(root, area), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (folder.isSymbolicLink()) throw new Error('symlink folder is forbidden');
      if (!folder.isDirectory()) continue;
      for (const file of (await readdir(join(root, area, folder.name), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (file.isSymbolicLink()) throw new Error('symlink article is forbidden');
        if (file.name.endsWith('.md')) {
          if (!file.isFile()) throw new Error('article is not a regular file');
          result.push({ area, folder: folder.name, path: area + '/' + folder.name + '/' + file.name });
        }
      }
    }
  }
  return result;
}

export async function parseVault(root: string): Promise<SyncSnapshot> {
  const base = await realpath(resolve(root));
  const assets = join(base, 'assets');
  for (const name of ['active', 'archive', 'assets']) {
    const directory = await lstat(join(base, name));
    if (directory.isSymbolicLink() || !directory.isDirectory()) throw new Error('vault directory must be a real directory');
  }
  if (await realpath(assets) !== assets) throw new Error('assets directory must not be a symlink');
  const objects = new Map<string, SyncSnapshot['objects'][number]>();
  const articles: SyncArticle[] = [];
  for (const entry of await articlePaths(base)) {
    const path = join(base, entry.path);
    const created = createdAt(basename(path));
    if (entry.folder.length > 512) throw new Error('article folder exceeds API length limit');
    if ((await lstat(path)).size > MAX_BODY_BYTES) throw new Error('article exceeds 256 KiB body limit');
    const body = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path)).trim();
    const title = titleFrom(body);
    const tags = [...new Set([...body.matchAll(/#([\p{L}\p{N}_]+)/gu)].map(match => match[1]))];
    if (tags.length > 64 || tags.some(tag => tag.length > 100)) throw new Error('article exceeds tag count or length limit');
    const attachments: Attachment[] = [];
    const seen = new Set<string>();
    const seenIds = new Set<string>();
    for (const match of body.matchAll(LINK)) {
      const name = assetName(match[3], entry.path);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const extension = name.slice(name.lastIndexOf('.')).toLowerCase();
      const mime = IMAGE_MIME[extension] ?? FILE_MIME[extension];
      if (!mime) throw new Error('unsupported asset type');
      const assetPath = join(assets, name);
      const file = await lstat(assetPath).catch(() => { throw new Error('missing asset referenced by article'); });
      if (file.isSymbolicLink()) throw new Error('symlink asset referenced by article');
      if (!file.isFile()) throw new Error('asset is not a regular file');
      if (file.size > MAX_ASSET_BYTES) throw new Error('asset exceeds 100 MiB limit');
      let canonical: string;
      try { canonical = await realpath(assetPath); }
      catch { throw new Error('missing asset referenced by article'); }
      if (canonical !== assetPath || !canonical.startsWith(assets + sep)) throw new Error('symlink or escaped asset referenced by article');
      const bytes = await readFile(assetPath);
      const id = sha256(bytes);
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      if (seenIds.size > 32) throw new Error('article exceeds 32 unique attachment limit');
      const originalKey = 'originals/' + id;
      if (objects.has(originalKey) && objects.get(originalKey)!.mime !== mime) {
        throw new Error('identical asset bytes have conflicting media types');
      }
      objects.set(originalKey, { key: originalKey, bytes, mime });
      let thumbnailKey: string | null = null;
      if (mime.startsWith('image/')) {
        let thumb: Buffer;
        try {
          thumb = await sharp(bytes, { failOn: 'error', limitInputPixels: 100_000_000 })
            .rotate().resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 75 }).toBuffer();
        } catch { throw new Error('cannot decode image referenced by article'); }
        thumbnailKey = 'thumbs/' + sha256(thumb) + '.webp';
        objects.set(thumbnailKey, { key: thumbnailKey, bytes: thumb, mime: 'image/webp' });
      }
      const label = match[2].replace(/&#(\d+);/g, (_, code: string) => {
        const point = Number(code);
        return point <= 0x10ffff ? String.fromCodePoint(point) : '';
      }).replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ({
        '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
      })[entity] ?? entity);
      attachments.push({ id, name: label || name, sourcePath: 'assets/' + name, mime, size: bytes.byteLength,
        originalKey, thumbnailKey });
    }
    const updated = updatedAt(base, entry.path);
    const searchText = normalizeSearch(title + '\n' + body);
    const tokens = searchTokens(searchText);
    const rowBytes = [entry.path, entry.folder, title, body, JSON.stringify(tags), JSON.stringify(attachments),
      searchText, tokens].reduce((total, value) => total + Buffer.byteLength(value), 0);
    if (rowBytes > MAX_ROW_BYTES) throw new Error('article exceeds D1 row payload limit');
    const article: SyncArticle = {
      id: sha256(entry.path), path: entry.path, area: entry.area, folder: entry.folder, title,
      createdAt: created, updatedAt: updated, body, tags, attachments,
      searchText, searchTokens: tokens, hash: '',
    };
    article.hash = sha256(JSON.stringify({ ...article, hash: undefined }));
    articles.push(article);
  }
  return { articles, objects: [...objects.values()].sort((a, b) => a.key.localeCompare(b.key)) };
}
