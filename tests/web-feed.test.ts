// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import type { Article } from '../src/shared/types';

it('keeps reading position, loaded thumbnails, and the search draft when the next page arrives', async () => {
  document.body.innerHTML = '<div id="app"></div>';
  const article = (id: string): Article => ({
    id, path: `active/notes/${id}.md`, area: 'active', folder: 'notes', title: id,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    body: '短い #tag メモ', tags: ['tag'], truncated: false,
    attachments: [{ id: 'image', name: 'test.png', sourcePath: 'assets/test.png', mime: 'image/png', size: 4, originalKey: 'originals/image', thumbnailKey: 'thumbs/image.webp' }],
  });
  let articlesRequest = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const isArticles = url.startsWith('/api/articles');
    if (isArticles) articlesRequest++;
    return Response.json({ items: isArticles ? [article(String(articlesRequest))] : [], revision: 1, nextCursor: isArticles && articlesRequest === 1 ? 'page2' : null });
  }));
  await import('../src/web/main');
  await vi.waitFor(() => expect(document.querySelectorAll('.post')).toHaveLength(1));
  const post = document.querySelector<HTMLElement>('.post')!;
  expect(post.getAttribute('aria-label')).toBe('1');
  expect(post.querySelector('.avatar, h3, .post-tags')).toBeNull();
  expect(post.querySelector('.post-header time')).not.toBeNull();
  expect(post.querySelectorAll('[data-action="select-tag"]')).toHaveLength(1);
  const scroll = document.querySelector<HTMLElement>('#feed-scroll')!;
  scroll.scrollTop = 450;
  const image = document.querySelector('.attachment img');
  const input = document.querySelector<HTMLInputElement>('#search-input')!;
  input.value = '入力途中';
  input.focus();
  document.querySelector<HTMLButtonElement>('[data-action="load-more"]')!.click();
  await vi.waitFor(() => expect(document.querySelectorAll('.post')).toHaveLength(2));
  expect(document.querySelector<HTMLElement>('#feed-scroll')!.scrollTop).toBe(450);
  expect(document.querySelector('.attachment img')).toBe(image);
  expect(document.querySelector<HTMLInputElement>('#search-input')!.value).toBe('入力途中');
  expect(document.activeElement?.id).toBe('search-input');
  document.querySelector<HTMLButtonElement>('.post [data-action="select-tag"]')!.click();
  await vi.waitFor(() => expect((fetch as ReturnType<typeof vi.fn>).mock.calls.some(([url]) => String(url).includes('tag=tag'))).toBe(true));
  vi.unstubAllGlobals();
});

it('does not repeat a thumbnail from the article body in the attachment list', async () => {
  document.body.innerHTML = '<div id="app"></div>';
  const article: Article = {
    id: 'linked-image', path: 'active/notes/linked-image.md', area: 'active', folder: 'notes', title: 'linked-image',
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    body: 'https://example.com\ntitle: Example\n\n![preview](../../assets/test.png)', tags: [], truncated: false,
    attachments: [{ id: 'image', name: 'test.png', sourcePath: 'assets/test.png', mime: 'image/png', size: 4, originalKey: 'originals/image', thumbnailKey: 'thumbs/image.webp' }],
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json({
    items: url.startsWith('/api/articles') ? [article] : [], revision: 1, nextCursor: null,
  })));
  vi.resetModules();
  await import('../src/web/main');
  await vi.waitFor(() => expect(document.querySelectorAll('.post')).toHaveLength(1));

  const post = document.querySelector('.post')!;
  expect(post.querySelectorAll('.url-block img')).toHaveLength(1);
  expect(post.querySelector('.attachment')).toBeNull();
  vi.unstubAllGlobals();
});
