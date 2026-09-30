// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import type { Article } from '../src/shared/types';

it('keeps reading position, loaded thumbnails, and the search draft when the next page arrives', async () => {
  document.body.innerHTML = '<div id="app"></div>';
  const article = (id: string): Article => ({
    id, path: `active/notes/${id}.md`, area: 'active', folder: 'notes', title: id,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    body: '短いメモ', tags: [], truncated: false,
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
  vi.unstubAllGlobals();
});
