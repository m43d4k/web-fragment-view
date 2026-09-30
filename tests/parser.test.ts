import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { parseVault } from '../scripts/sync/parser';

const roots: string[] = [];
async function vault() {
  const root = await mkdtemp(join(tmpdir(), 'fragment-view-parser-'));
  roots.push(root);
  for (const folder of ['active/inbox', 'archive/inbox', 'assets']) await mkdir(join(root, folder), { recursive: true });
  return root;
}
function commit(root: string) {
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture'], {
    env: { ...process.env, GIT_AUTHOR_DATE: '2026-09-29T12:34:56+09:00', GIT_COMMITTER_DATE: '2026-09-29T12:34:56+09:00' },
  });
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('vault parser', () => {
  it('uses the PC app timestamp, title, tag and attachment syntax', async () => {
    const root = await vault();
    const image = await sharp({ create: { width: 640, height: 400, channels: 3, background: 'blue' } }).webp().toBuffer();
    await writeFile(join(root, 'assets', 'photo.webp'), image);
    await writeFile(join(root, 'assets', 'attachment_' + 'a'.repeat(32) + '.txt'), 'sample');
    await writeFile(join(root, 'active/inbox/20260929_120102_123456.md'),
      'https://example.test/a\ntitle: Example title\n\n本文 #日本語 #favorite #日本語\n![](../../assets/photo.webp)  \n[notes.txt](../../assets/attachment_' + 'a'.repeat(32) + '.txt)  \n');
    await writeFile(join(root, 'archive/inbox/20260928_230000.md'), '# Heading\nArchive #保管');
    commit(root);

    const first = await parseVault(root);
    const second = await parseVault(root);
    expect(first).toEqual(second);
    expect(first.articles).toHaveLength(2);
    const active = first.articles.find(item => item.area === 'active')!;
    expect(active).toMatchObject({ area: 'active', folder: 'inbox', title: 'Example title',
      createdAt: '2026-09-29T03:01:02.123Z', updatedAt: '2026-09-29T03:34:56.000Z',
      tags: ['日本語', 'favorite'], path: 'active/inbox/20260929_120102_123456.md' });
    expect(active.searchText).toContain('example title');
    expect(active.attachments).toHaveLength(2);
    expect(active.attachments.map(item => item.mime)).toEqual(['image/webp', 'text/plain']);
    expect(active.attachments[0].thumbnailKey).toMatch(/^thumbs\/[a-f0-9]{64}\.webp$/);
    expect(active.attachments[1].thumbnailKey).toBeNull();
    expect(first.objects).toHaveLength(3);
    expect(first.articles.find(item => item.area === 'archive')).toMatchObject({ title: 'Heading',
      createdAt: '2026-09-28T14:00:00.000Z' });
  });

  it('changes the article hash when a referenced image changes, and ignores orphan assets', async () => {
    const root = await vault();
    const article = join(root, 'active/inbox/20260929_120000.md');
    await writeFile(article, '![](../../assets/a.webp)');
    await writeFile(join(root, 'assets/a.webp'), await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).webp().toBuffer());
    await writeFile(join(root, 'assets/orphan.txt'), 'private orphan');
    commit(root);
    const first = await parseVault(root);
    expect(first.objects).toHaveLength(2);
    await writeFile(join(root, 'assets/a.webp'), await sharp({ create: { width: 10, height: 10, channels: 3, background: 'green' } }).webp().toBuffer());
    const second = await parseVault(root);
    expect(second.articles[0].id).toBe(first.articles[0].id);
    expect(second.articles[0].hash).not.toBe(first.articles[0].hash);
  });

  it('fails on malformed dates, missing assets and symlinks', async () => {
    const root = await vault();
    const bad = join(root, 'active/inbox/invalid.md');
    await writeFile(bad, 'body');
    await expect(parseVault(root)).rejects.toThrow(/timestamp|filename/i);
    await rm(bad);
    const article = join(root, 'active/inbox/20260230_120000.md');
    await writeFile(article, 'body');
    await expect(parseVault(root)).rejects.toThrow(/timestamp|date/i);
    await rm(article);
    await writeFile(article.replace('20260230', '20260228'), '![](../../assets/missing.webp)');
    await expect(parseVault(root)).rejects.toThrow(/missing|asset/i);
    await symlink(join(root, 'assets/missing.webp'), join(root, 'assets/linked.webp'));
    await writeFile(article.replace('20260230', '20260228'), '![](../../assets/linked.webp)');
    await expect(parseVault(root)).rejects.toThrow(/symlink/i);
  });

  it('deduplicates equal asset bytes within one article and does not fetch external images', async () => {
    const root = await vault();
    const image = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).webp().toBuffer();
    await writeFile(join(root, 'assets/a.webp'), image);
    await writeFile(join(root, 'assets/b.webp'), image);
    await writeFile(join(root, 'active/inbox/20260929_120000.md'),
      '![](../../assets/a.webp)\n![](../../assets/b.webp)\n![](https://example.test/external.png)');
    commit(root);
    const result = await parseVault(root);
    expect(result.articles[0].attachments).toHaveLength(1);
    expect(result.objects).toHaveLength(2);
  });

  it('rejects links that escape shared assets and rows beyond parser limits', async () => {
    const root = await vault();
    const article = join(root, 'active/inbox/20260929_120000.md');
    await writeFile(article, '![](../../../assets/a.webp)');
    await expect(parseVault(root)).rejects.toThrow(/leaves the shared assets/);
    await writeFile(article, Array.from({ length: 65 }, (_, i) => '#tag' + i).join(' '));
    await expect(parseVault(root)).rejects.toThrow(/tag count/);
    await writeFile(article, 'a'.repeat(256 * 1024 + 1));
    await expect(parseVault(root)).rejects.toThrow(/256 KiB/);
  });
});
