// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import type { Article } from '../src/shared/types';

beforeEach(() => sessionStorage.clear());

const channelPage = () => Response.json({
  items: [{ folder: 'notes', area: 'active', count: 1 }], revision: 1, nextCursor: null,
});

it('keeps reading position, loaded thumbnails, and the search draft when the next page arrives', async () => {
  document.body.innerHTML = '<div id="app"></div>';
  const article = (id: string): Article => ({
    id, path: `active/notes/${id}.md`, area: 'active', folder: 'notes', title: id,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    body: '短いメモ\n#tag', tags: ['tag'], truncated: false,
    attachments: [{ id: 'image', name: 'test.png', sourcePath: 'assets/test.png', mime: 'image/png', size: 4, originalKey: 'originals/image', thumbnailKey: 'thumbs/image.webp' }],
  });
  let articlesRequest = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/channels')) return channelPage();
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
  document.querySelector<HTMLButtonElement>('[data-action="open-search"]')!.click();
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
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.startsWith('/api/channels') ? channelPage() : Response.json({
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

it('toggles multiple tags, switches AND/OR, and clears one selection without losing the others', async () => {
  document.body.innerHTML = '<div id="app"></div>';
  const calls: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/channels')) return channelPage();
    const parsed = new URL(url, 'https://viewer.example');
    if (parsed.pathname === '/api/articles') calls.push(parsed);
    return Response.json({ items: parsed.pathname === '/api/tags' ? [{ name: 'A', count: 2 }, { name: 'B', count: 1 }] : [], revision: 1, nextCursor: null });
  }));
  vi.resetModules();
  await import('../src/web/main');
  await vi.waitFor(() => expect(document.querySelectorAll('.tag-option')).toHaveLength(2));
  const click = async (selector: string) => {
    document.querySelector<HTMLButtonElement>(selector)!.click();
    await vi.waitFor(() => expect(document.querySelectorAll('.tag-option')).toHaveLength(2));
  };
  await click('.tag-option[data-tag="A"]');
  await vi.waitFor(() => expect(calls.at(-1)?.searchParams.getAll('tag')).toEqual(['A']));
  await click('.tag-option[data-tag="B"]');
  await vi.waitFor(() => expect(calls.at(-1)?.searchParams.getAll('tag')).toEqual(['A', 'B']));
  expect(calls.at(-1)?.searchParams.get('tagMode')).toBe('AND');
  expect(document.querySelectorAll('.tag-option[aria-pressed="true"]')).toHaveLength(2);
  await click('[data-action="toggle-tag-mode"]');
  await vi.waitFor(() => expect(calls.at(-1)?.searchParams.get('tagMode')).toBe('OR'));
  expect(calls.at(-1)?.searchParams.getAll('tag')).toEqual(['A', 'B']);
  await click('[data-action="clear-tag"][data-tag="A"]');
  await vi.waitFor(() => expect(calls.at(-1)?.searchParams.getAll('tag')).toEqual(['B']));
  await click('.tag-option[data-tag="B"]');
  await vi.waitFor(() => expect(calls.at(-1)?.searchParams.getAll('tag')).toEqual([]));
  expect(calls.at(-1)?.searchParams.has('cursor')).toBe(false);
  await click('.tag-option[data-tag="A"]');
  await click('.tag-option[data-tag="B"]');
  await vi.waitFor(() => expect(document.querySelectorAll('.tag-option[aria-pressed="true"]')).toHaveLength(2));
  await click('[data-action="clear-tags"]');
  await vi.waitFor(() => expect(calls.at(-1)?.searchParams.getAll('tag')).toEqual([]));
  expect(calls.at(-1)?.searchParams.get('tagMode')).toBe('OR');
  expect(document.querySelectorAll('.tag-option[aria-pressed="true"]')).toHaveLength(0);
  expect(document.querySelector<HTMLButtonElement>('[data-action="clear-tags"]')!.disabled).toBe(true);

  vi.unstubAllGlobals();
});

it('reloads folder tags, clears prior tag selections, and ignores late responses from the previous folder', async () => {
  document.body.innerHTML = '<div id="app"></div>';
  let finishA!: (value: Response) => void;
  const articleRequests: URL[] = [];
  const page = (items: unknown[]) => Response.json({ items, revision: 1, nextCursor: null });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const parsed = new URL(url, 'https://viewer.example');
    if (parsed.pathname === '/api/channels') return page(['notes', 'A', 'B'].map(folder => ({ folder, area: 'active', count: 1 })));
    if (parsed.pathname === '/api/tags') {
      if (parsed.searchParams.get('folder') === 'A') return new Promise<Response>(resolve => { finishA = resolve; });
      return page([{ name: parsed.searchParams.get('folder') === 'B' ? 'B-only' : 'all', count: 1 }]);
    }
    articleRequests.push(parsed);
    return page([]);
  }));
  vi.resetModules();
  await import('../src/web/main');
  await vi.waitFor(() => expect(document.querySelector('.tag-option[data-tag="all"]')).not.toBeNull());
  const click = (selector: string) => document.querySelector<HTMLButtonElement>(selector)!.click();
  click('.tag-option[data-tag="all"]');
  click('[data-action="select-folder"][data-folder="A"]');
  await vi.waitFor(() => expect(finishA).toBeTypeOf('function'));
  expect(document.querySelectorAll('.tag-option')).toHaveLength(0);
  expect(articleRequests.at(-1)?.searchParams.getAll('tag')).toEqual([]);
  click('[data-action="select-folder"][data-folder="B"]');
  await vi.waitFor(() => expect(document.querySelector('.tag-option[data-tag="B-only"]')).not.toBeNull());
  finishA(page([{ name: 'A-only', count: 1 }]));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(document.querySelector('.tag-option[data-tag="A-only"]')).toBeNull();
  expect(document.querySelector('.main-panel .current-channel strong')?.textContent).toBe('B');
  expect(document.querySelector('.active-filters')).toBeNull();
  expect(articleRequests.at(-1)?.searchParams.get('folder')).toBe('B');
  click('.tag-option[data-tag="B-only"]');
  expect(document.querySelector('.active-filters [data-action="clear-tag"]')?.textContent).toContain('B-only');
  expect(document.querySelector('[data-action="clear-folder"]')).toBeNull();
  click('.active-filters [data-action="clear-tag"]');
  expect(document.querySelector('.active-filters')).toBeNull();
  expect(articleRequests.at(-1)?.searchParams.get('folder')).toBe('B');
  click('[data-action="select-folder"][data-folder="notes"]');
  await vi.waitFor(() => expect(document.querySelector('.tag-option[data-tag="all"]')).not.toBeNull());
  vi.unstubAllGlobals();
});

it('sends inclusive date selections with search and preserves them during pagination', async () => {
  document.body.innerHTML = '<div id="app"></div>';
  const calls: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/channels')) return channelPage();
    const parsed = new URL(url, 'https://viewer.example');
    if (parsed.pathname === '/api/articles') calls.push(parsed);
    return Response.json({ items: [], revision: 1, nextCursor: parsed.pathname === '/api/articles' && !parsed.searchParams.has('cursor') ? 'page2' : null });
  }));
  vi.resetModules();
  await import('../src/web/main');
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  expect(document.querySelector('#date-from')).toBeNull();
  document.querySelector<HTMLButtonElement>('[data-action="open-search"]')!.click();
  expect(document.querySelector('#search-panel #date-from')).not.toBeNull();
  const setDate = (id: string, value: string) => {
    const input = document.querySelector<HTMLInputElement>(id)!;
    input.value = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  setDate('#date-from', '2026-09-01');
  setDate('#date-to', '2026-09-30');
  await vi.waitFor(() => expect(calls.at(-1)?.searchParams.get('dateTo')).toBe('2026-09-30'));
  expect(calls.at(-1)?.searchParams.get('dateFrom')).toBe('2026-09-01');
  expect(document.querySelector('#search-scroll')).not.toBeNull();
  expect(calls.filter(url => !url.searchParams.has('dateFrom'))).toHaveLength(1);
  document.querySelector<HTMLInputElement>('#search-input')!.value = '音楽';
  document.querySelector<HTMLFormElement>('#search-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(calls.at(-1)?.searchParams.get('q')).toBe('音楽'));
  await vi.waitFor(() => expect(document.querySelector('#search-panel [data-action="load-more"]')).not.toBeNull());
  document.querySelector<HTMLButtonElement>('#search-panel [data-action="load-more"]')!.click();
  await vi.waitFor(() => expect(calls.at(-1)?.searchParams.get('cursor')).toBe('page2'));
  expect(calls.at(-1)?.searchParams.get('dateFrom')).toBe('2026-09-01');
  expect(calls.at(-1)?.searchParams.get('dateTo')).toBe('2026-09-30');
  const beforeClear = calls.length;
  document.querySelector<HTMLButtonElement>('[data-action="clear-dates"]')!.click();
  await vi.waitFor(() => expect(calls.at(-1)?.searchParams.has('dateFrom')).toBe(false));
  expect(calls.at(-1)?.searchParams.has('dateTo')).toBe(false);
  expect(calls.at(-1)?.searchParams.has('cursor')).toBe(false);
  expect(calls.at(-1)?.searchParams.get('q')).toBe('音楽');
  expect(calls.slice(beforeClear).map(url => url.searchParams.get('q'))).toEqual(['音楽']);
  setDate('#date-to', '2026-09-30');
  document.querySelector<HTMLButtonElement>('#search-panel [data-action="close-search"]')!.click();
  document.querySelector<HTMLButtonElement>('[data-action="open-search"]')!.click();
  expect(document.querySelector<HTMLInputElement>('#date-to')!.value).toBe('');
  expect(document.querySelector('#search-scroll')).toBeNull();
  vi.unstubAllGlobals();
});


it('opens a separate search panel and preserves the feed and its reading position when searching and closing', async () => {
  document.body.innerHTML = '<div id="app"></div>';
  const calls: URL[] = [];
  const article: Article = {
    id: 'same', path: 'active/notes/same.md', area: 'active', folder: 'notes', title: 'same',
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    body: '検索対象', tags: [], truncated: false, attachments: [],
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/channels')) return channelPage();
    const parsed = new URL(url, 'https://viewer.example');
    if (parsed.pathname === '/api/articles') calls.push(parsed);
    return Response.json({ items: parsed.pathname === '/api/articles' ? [article] : [], revision: 1, nextCursor: null });
  }));
  vi.resetModules();
  await import('../src/web/main');
  await vi.waitFor(() => expect(document.querySelector('#feed-scroll .post')).not.toBeNull());
  const post = document.querySelector('#feed-scroll .post');
  document.querySelector<HTMLElement>('#feed-scroll')!.scrollTop = 275;
  expect(document.querySelector('#search-input')).toBeNull();
  expect(document.querySelector('#search-panel')).toBeNull();
  const opener = document.querySelector<HTMLButtonElement>('.topbar [data-action="open-search"]')!;
  expect(opener.getAttribute('aria-label')).toBeTruthy();
  opener.click();
  expect(document.activeElement?.id).toBe('search-input');
  expect(document.querySelector('#search-panel #search-form')).not.toBeNull();
  document.querySelector<HTMLInputElement>('#search-input')!.value = '検索';
  document.querySelector<HTMLFormElement>('#search-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(document.querySelector('#search-scroll .post')).not.toBeNull());
  expect(calls.filter(url => !url.searchParams.has('q'))).toHaveLength(1);
  expect(calls.at(-1)?.searchParams.get('q')).toBe('検索');
  expect(document.querySelector('#feed-scroll .post')).toBe(post);
  expect(document.querySelector('#search-scroll .post')).not.toBe(post);
  expect(document.querySelector<HTMLElement>('#feed-scroll')!.scrollTop).toBe(275);
  document.querySelector<HTMLButtonElement>('#search-panel [data-action="close-search"]')!.click();
  expect(document.querySelector('#search-panel')).toBeNull();
  expect(document.querySelector('#feed-scroll .post')).toBe(post);
  expect(document.querySelector<HTMLElement>('#feed-scroll')!.scrollTop).toBe(275);
  expect(document.activeElement?.getAttribute('data-action')).toBe('open-search');
  expect(calls.filter(url => !url.searchParams.has('q'))).toHaveLength(1);
  vi.unstubAllGlobals();
});

it('ignores a search response that arrives after closing and reopening search', async () => {
  document.body.innerHTML = '<div id="app"></div>';
  let finishSearch!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/channels')) return channelPage();
    const parsed = new URL(url, 'https://viewer.example');
    if (parsed.pathname === '/api/articles' && parsed.searchParams.has('q')) {
      return new Promise<Response>(resolve => { finishSearch = resolve; });
    }
    return Response.json({ items: [], revision: 1, nextCursor: null });
  }));
  vi.resetModules();
  await import('../src/web/main');
  await vi.waitFor(() => expect(document.querySelector('.loading-row')).toBeNull());
  document.querySelector<HTMLButtonElement>('[data-action="open-search"]')!.click();
  document.querySelector<HTMLInputElement>('#search-input')!.value = '古い検索';
  document.querySelector<HTMLFormElement>('#search-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(finishSearch).toBeTypeOf('function'));
  document.querySelector<HTMLButtonElement>('#search-panel [data-action="close-search"]')!.click();
  document.querySelector<HTMLButtonElement>('[data-action="open-search"]')!.click();
  finishSearch(Response.json({ items: [{
    id: 'late', path: 'active/notes/late.md', area: 'active', folder: 'notes', title: 'late',
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    body: '古い検索結果', tags: [], truncated: false, attachments: [],
  }], revision: 1, nextCursor: null }));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(document.querySelectorAll('.post')).toHaveLength(0);
  expect(document.querySelector<HTMLInputElement>('#search-input')!.value).toBe('');
  vi.unstubAllGlobals();
});

it('searches tags on the server without changing selected tags or the article feed', async () => {
  document.body.innerHTML = '<div id="app"></div>';
  const calls: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/channels')) return channelPage();
    const parsed = new URL(url, 'https://viewer.example');
    calls.push(parsed);
    return Response.json({ items: parsed.pathname === '/api/tags' ? [{ name: parsed.searchParams.get('q') || '選択済み', count: 1 }] : [], revision: 1, nextCursor: null });
  }));
  vi.resetModules();
  await import('../src/web/main');
  await vi.waitFor(() => expect(document.querySelector('.tag-option')).not.toBeNull());
  document.querySelector<HTMLButtonElement>('.tag-option')!.click();
  await vi.waitFor(() => expect(document.querySelector('.loading-row')).toBeNull());
  const feedRequests = calls.filter(url => url.pathname === '/api/articles').length;
  const input = document.querySelector<HTMLInputElement>('#tag-search-input')!;
  input.value = '音';
  input.focus();
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector<HTMLInputElement>('#tag-search-input')!.value = '音楽';
  document.querySelector('#tag-search-input')!.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.waitFor(() => expect(document.querySelector('.tag-option[data-tag="音楽"]')).not.toBeNull());
  expect(calls.filter(url => url.pathname === '/api/tags').at(-1)?.searchParams.get('q')).toBe('音楽');
  expect(calls.some(url => url.searchParams.get('q') === '音')).toBe(false);
  expect(calls.filter(url => url.pathname === '/api/articles')).toHaveLength(feedRequests);
  expect(document.querySelector('[data-action="clear-tag"][data-tag="選択済み"]')).not.toBeNull();
  expect(document.activeElement?.id).toBe('tag-search-input');
  document.querySelector<HTMLInputElement>('#tag-search-input')!.value = '';
  document.querySelector('#tag-search-input')!.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.waitFor(() => expect(calls.filter(url => url.pathname === '/api/tags').at(-1)?.searchParams.has('q')).toBe(false));
  await vi.waitFor(() => expect(document.querySelector('.tag-option[aria-pressed="true"]')).not.toBeNull());
  vi.unstubAllGlobals();
});

it('refreshes tag availability with selection and mode, keeping selected tags visible during search', async () => {
  document.body.innerHTML = '<div id="app"></div>';
  const tagCalls: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/channels')) return channelPage();
    const parsed = new URL(url, 'https://viewer.example');
    if (parsed.pathname === '/api/tags') tagCalls.push(parsed);
    const selected = parsed.searchParams.getAll('tag');
    return Response.json({ items: parsed.pathname === '/api/tags' ? [
      ...(!parsed.searchParams.get('q') ? [{ name: 'A', count: 1, available: true }] : []),
      { name: 'B', count: 1, available: !selected.includes('A') || parsed.searchParams.get('tagMode') === 'OR' },
    ] : [], revision: 1, nextCursor: null });
  }));
  vi.resetModules();
  await import('../src/web/main');
  await vi.waitFor(() => expect(document.querySelector('.tag-option[data-tag="A"]')).not.toBeNull());
  document.querySelector<HTMLButtonElement>('.tag-option[data-tag="A"]')!.click();
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('.tag-option[data-tag="B"]')?.disabled).toBe(true));
  expect(tagCalls.at(-1)?.searchParams.getAll('tag')).toEqual(['A']);
  const input = document.querySelector<HTMLInputElement>('#tag-search-input')!;
  input.value = 'B';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.waitFor(() => expect(tagCalls.at(-1)?.searchParams.get('q')).toBe('B'));
  expect(document.querySelector('.tag-option[data-tag="A"][aria-pressed="true"]')).not.toBeNull();
  document.querySelector<HTMLButtonElement>('[data-action="toggle-tag-mode"]')!.click();
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('.tag-option[data-tag="B"]')?.disabled).toBe(false));
  expect(tagCalls.at(-1)?.searchParams.get('tagMode')).toBe('OR');
  document.querySelector<HTMLButtonElement>('[data-action="clear-tags"]')!.click();
  await vi.waitFor(() => expect(tagCalls.at(-1)?.searchParams.getAll('tag')).toEqual([]));
  vi.unstubAllGlobals();
});

it('toggles favorites independently of OR tags and applies them to search and subsequent pages', async () => {
  document.body.innerHTML = '<div id="app"></div>';
  const calls: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/channels')) return channelPage();
    const parsed = new URL(url, 'https://viewer.example');
    if (parsed.pathname === '/api/articles') calls.push(parsed);
    return Response.json({ items: parsed.pathname === '/api/tags' ? [{ name: 'memo', count: 1 }] : [], revision: 1,
      nextCursor: parsed.pathname === '/api/articles' && !parsed.searchParams.has('cursor') ? 'next' : null });
  }));
  vi.resetModules();
  await import('../src/web/main');
  await vi.waitFor(() => expect(document.querySelectorAll('.tag-option')).toHaveLength(1));
  const click = async (selector: string) => {
    document.querySelector<HTMLButtonElement>(selector)!.click();
    await vi.waitFor(() => expect(document.querySelector('.loading-row')).toBeNull());
  };
  const favorite = '.main-panel [data-action="toggle-favorites"]';
  expect(document.querySelector(favorite)?.getAttribute('aria-pressed')).toBe('false');
  await click('.tag-option');
  await click('[data-action="toggle-tag-mode"]');
  await click(favorite);
  expect(document.querySelector(favorite)?.getAttribute('aria-pressed')).toBe('true');
  expect(calls.at(-1)?.searchParams.get('favorites')).toBe('true');
  expect(calls.at(-1)?.searchParams.getAll('tag')).toEqual(['memo']);
  expect(calls.at(-1)?.searchParams.get('tagMode')).toBe('OR');
  expect(calls.at(-1)?.searchParams.has('cursor')).toBe(false);
  await click('.main-panel [data-action="load-more"]');
  expect(calls.at(-1)?.searchParams.get('favorites')).toBe('true');
  expect(calls.at(-1)?.searchParams.get('cursor')).toBe('next');
  await click('[data-action="open-search"]');
  document.querySelector<HTMLInputElement>('#search-input')!.value = 'note';
  document.querySelector<HTMLFormElement>('#search-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(calls.at(-1)?.searchParams.get('q')).toBe('note'));
  expect(calls.at(-1)?.searchParams.get('favorites')).toBe('true');
  await click(favorite);
  expect(document.querySelector(favorite)?.getAttribute('aria-pressed')).toBe('false');
  expect(calls.at(-1)?.searchParams.has('favorites')).toBe(false);
  await click(favorite);
  await click('.main-panel .clear-all');
  expect(document.querySelector(favorite)?.getAttribute('aria-pressed')).toBe('false');
  expect(calls.at(-1)?.searchParams.has('favorites')).toBe(false);
  vi.unstubAllGlobals();
});

it('waits for channels, opens the first in server order, and keeps the folder when clearing filters', async () => {
  document.body.innerHTML = '<div id="app"></div>';
  let finishChannels!: (response: Response) => void;
  const calls: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const parsed = new URL(url, 'https://viewer.example');
    calls.push(parsed);
    if (parsed.pathname === '/api/channels') return new Promise<Response>(resolve => { finishChannels = resolve; });
    return Response.json({ items: parsed.pathname === '/api/tags' ? [{ name: 'tag', count: 1 }] : [], revision: 1, nextCursor: null });
  }));
  vi.resetModules();
  await import('../src/web/main');
  expect(calls.map(url => url.pathname)).toEqual(['/api/channels']);
  expect(document.body.textContent).not.toContain('すべての記事');
  finishChannels(Response.json({ items: ['Z', 'A'].map(folder => ({ folder, area: 'active', count: 1 })), revision: 1, nextCursor: null }));
  await vi.waitFor(() => expect(document.querySelector('.tag-option')).not.toBeNull());
  expect(document.querySelector('.channel-row.selected')?.getAttribute('data-folder')).toBe('Z');
  expect(document.querySelector('.main-panel .current-channel strong')?.textContent).toBe('Z');
  expect(calls.filter(url => url.pathname !== '/api/channels').every(url => url.searchParams.get('folder') === 'Z')).toBe(true);
  document.querySelector<HTMLButtonElement>('.tag-option')!.click();
  document.querySelector<HTMLButtonElement>('.clear-all')!.click();
  await vi.waitFor(() => expect(document.querySelector('.loading-row')).toBeNull());
  expect(document.querySelector('.channel-row.selected')?.getAttribute('data-folder')).toBe('Z');
  expect(calls.filter(url => url.pathname === '/api/articles').at(-1)?.searchParams.getAll('tag')).toEqual([]);
  expect(calls.filter(url => url.pathname !== '/api/channels').every(url => url.searchParams.has('folder'))).toBe(true);
  vi.unstubAllGlobals();
});

it('retries a failed channel load and leaves an empty area without fetching all articles', async () => {
  document.body.innerHTML = '<div id="app"></div>';
  const calls: URL[] = [];
  let fail = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const parsed = new URL(url, 'https://viewer.example');
    calls.push(parsed);
    if (fail) return Response.json({ error: 'フォルダ取得失敗' }, { status: 503 });
    return Response.json({ items: [], revision: 1, nextCursor: null });
  }));
  vi.resetModules();
  await import('../src/web/main');
  await vi.waitFor(() => expect(document.querySelector('.side-error')?.textContent).toContain('フォルダ取得失敗'));
  expect(calls.map(url => url.pathname)).toEqual(['/api/channels']);
  fail = false;
  document.querySelector<HTMLButtonElement>('[data-action="load-channels"]')!.click();
  await vi.waitFor(() => expect(document.querySelector('.side-error')).toBeNull());
  await vi.waitFor(() => expect(document.querySelector('#feed-scroll')?.textContent).toContain('フォルダはありません'));
  expect(calls.map(url => url.pathname)).toEqual(['/api/channels', '/api/channels']);
  vi.unstubAllGlobals();
});

it('opens the first folder of the new area and ignores a late channel response from the previous area', async () => {
  document.body.innerHTML = '<div id="app"></div>';
  let finishActive!: (response: Response) => void;
  const calls: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const parsed = new URL(url, 'https://viewer.example');
    calls.push(parsed);
    if (parsed.pathname === '/api/channels') {
      if (parsed.searchParams.get('area') === 'active') return new Promise<Response>(resolve => { finishActive = resolve; });
      return Response.json({ items: [{ folder: 'archive-first', area: 'archive', count: 1 }], revision: 1, nextCursor: null });
    }
    return Response.json({ items: [], revision: 1, nextCursor: null });
  }));
  vi.resetModules();
  await import('../src/web/main');
  document.querySelector<HTMLButtonElement>('[data-action="area"][data-area="archive"]')!.click();
  await vi.waitFor(() => expect(document.querySelector('.channel-row.selected')?.getAttribute('data-folder')).toBe('archive-first'));
  finishActive(channelPage());
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(document.querySelector('.main-panel .current-channel strong')?.textContent).toBe('archive-first');
  expect(calls.filter(url => url.pathname !== '/api/channels').map(url => [url.searchParams.get('area'), url.searchParams.get('folder')]))
    .toEqual([['archive', 'archive-first'], ['archive', 'archive-first']]);
  vi.unstubAllGlobals();
});


it('restores the last folder and area after reload, including a folder beyond the first channel page', async () => {
  const calls: URL[] = [];
  let reloaded = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const parsed = new URL(url, 'https://viewer.example');
    calls.push(parsed);
    const area = parsed.searchParams.get('area') ?? 'active';
    const folders = area === 'active' ? ['first', 'second'] : ['archive-first', 'archive-second'];
    return Response.json({ items: parsed.pathname === '/api/channels'
      ? (reloaded ? folders.slice(0, 1) : folders).map(folder => ({ folder, area, count: 1 })) : [],
      revision: 1, nextCursor: reloaded && parsed.pathname === '/api/channels' ? 'more' : null });
  }));
  const boot = async () => {
    document.body.innerHTML = '<div id="app"></div>';
    vi.resetModules();
    await import('../src/web/main');
    await vi.waitFor(() => expect(document.querySelector('.loading-row')).toBeNull());
  };
  const click = async (selector: string) => {
    document.querySelector<HTMLButtonElement>(selector)!.click();
    await vi.waitFor(() => expect(document.querySelector('.loading-row')).toBeNull());
  };
  await boot();
  await click('[data-folder="second"]');
  await click('[data-action="area"][data-area="archive"]');
  await click('[data-folder="archive-second"]');
  reloaded = true;
  calls.length = 0;
  await boot();
  expect(document.querySelector('.main-panel .current-channel strong')?.textContent).toBe('archive-second');
  expect(calls.filter(url => url.pathname === '/api/articles').map(url => [url.searchParams.get('area'), url.searchParams.get('folder')]))
    .toEqual([['archive', 'archive-second']]);
  await click('[data-action="area"][data-area="active"]');
  expect(document.querySelector('.main-panel .current-channel strong')?.textContent).toBe('second');
  sessionStorage.clear();
  await boot();
  expect(document.querySelector('.main-panel .current-channel strong')?.textContent).toBe('first');
  vi.unstubAllGlobals();
});
