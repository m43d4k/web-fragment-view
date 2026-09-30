import type { ApiError, Area, Article, Channel, Page, Tag } from '../shared/types';
import { safeMarkdown } from './markdown';
import { attachmentMarkup } from './attachments';
import { appendWithinWindow, ARTICLE_WINDOW_LIMIT, startOlderWindow } from './feed-window';

interface Metadata<T> {
  items: T[];
  cursor: string | null;
  loading: boolean;
  error: string | null;
}

interface State {
  area: Area;
  folder: string | null;
  tag: string | null;
  query: string;
  channels: Metadata<Channel>;
  tags: Metadata<Tag>;
  articles: Article[];
  cursor: string | null;
  loadingFeed: boolean;
  feedError: string | null;
  revisionMismatch: boolean;
  feedGeneration: number;
  channelDrawerOpen: boolean;
  expandedIds: Set<string>;
  loadingDetails: Set<string>;
  detailErrors: Map<string, string>;
  fullArticles: Map<string, Article>;
}

const state: State = {
  area: 'active',
  folder: null,
  tag: null,
  query: '',
  channels: emptyMetadata(),
  tags: emptyMetadata(),
  articles: [],
  cursor: null,
  loadingFeed: false,
  feedError: null,
  revisionMismatch: false,
  feedGeneration: 0,
  channelDrawerOpen: false,
  expandedIds: new Set(),
  loadingDetails: new Set(),
  detailErrors: new Map(),
  fullArticles: new Map(),
};

function emptyMetadata<T>(): Metadata<T> {
  return { items: [], cursor: null, loading: false, error: null };
}

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('アプリの表示領域がありません。');

let feedController: AbortController | null = null;
let metadataControllers: Array<{ kind: 'channels' | 'tags'; area: Area; controller: AbortController }> = [];
let resetScrollOnRender = false;
let renderedQuery: string | null = null;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]!);
}

async function request<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', signal });
  const data = await response.json().catch(() => null) as T | ApiError | null;
  if (!response.ok) {
    if (response.status === 409) throw new RevisionMismatchError();
    const message = typeof data === 'object' && data !== null && 'error' in data
      ? data.error
      : `通信に失敗しました (${response.status})`;
    throw new Error(message);
  }
  return data as T;
}

class RevisionMismatchError extends Error {
  constructor() { super('同期中に一覧が更新されました。最新の一覧から読み直してください。'); }
}

function queryString(params: Record<string, string | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const result = search.toString();
  return result ? `?${result}` : '';
}

function resetFeed(): void {
  resetScrollOnRender = true;
  feedController?.abort();
  state.feedGeneration += 1;
  state.articles = [];
  state.cursor = null;
  state.loadingFeed = false;
  state.feedError = null;
  state.revisionMismatch = false;
  state.expandedIds.clear();
  state.loadingDetails.clear();
  state.detailErrors.clear();
  state.fullArticles.clear();
  void loadFeed(true);
}

async function loadMetadata<T>(kind: 'channels' | 'tags', reset = false): Promise<void> {
  const metadata = state[kind] as Metadata<T>;
  if (metadata.loading || (!reset && metadata.cursor === null && metadata.items.length > 0)) return;
  if (reset) {
    metadataControllers = metadataControllers.filter((entry) => {
      if (entry.kind === kind) { entry.controller.abort(); return false; }
      return true;
    });
    metadata.items = [];
    metadata.cursor = null;
    metadata.error = null;
  }
  metadata.loading = true;
  metadata.error = null;
  render();
  const controller = new AbortController();
  const requestedArea = state.area;
  metadataControllers.push({ kind, area: requestedArea, controller });
  const params = { area: state.area, cursor: metadata.cursor };
  try {
    const page = await request<Page<T>>(`/api/${kind}${queryString(params)}`, controller.signal);
    if (requestedArea !== state.area) return;
    metadata.items = [...metadata.items, ...page.items];
    metadata.cursor = page.nextCursor;
  } catch (error) {
    if (requestedArea !== state.area) return;
    if (error instanceof RevisionMismatchError) {
      metadata.items = [];
      metadata.cursor = null;
      metadata.error = '一覧が更新されました。最新のフォルダ・タグを再取得してください。';
    } else if (!(error instanceof DOMException && error.name === 'AbortError')) metadata.error = errorMessage(error);
  } finally {
    if (requestedArea === state.area) {
      metadata.loading = false;
      render();
    }
  }
}

async function loadFeed(firstPage = false): Promise<void> {
  if (state.loadingFeed || state.revisionMismatch || state.articles.length >= ARTICLE_WINDOW_LIMIT) return;
  if (!firstPage && state.cursor === null) return;
  const generation = state.feedGeneration;
  feedController?.abort();
  const controller = new AbortController();
  feedController = controller;
  state.loadingFeed = true;
  state.feedError = null;
  render();
  const params = {
    area: state.area,
    folder: state.folder,
    tag: state.tag,
    q: state.query || null,
    cursor: firstPage ? null : state.cursor,
  };
  try {
    const page = await request<Page<Article>>(`/api/articles${queryString(params)}`, controller.signal);
    if (generation !== state.feedGeneration) return;
    state.articles = appendWithinWindow(state.articles, page.items);
    state.cursor = page.nextCursor;
  } catch (error) {
    if (generation !== state.feedGeneration) return;
    if (error instanceof RevisionMismatchError) state.revisionMismatch = true;
    else if (!(error instanceof DOMException && error.name === 'AbortError')) state.feedError = errorMessage(error);
  } finally {
    if (generation === state.feedGeneration) {
      state.loadingFeed = false;
      render();
    }
  }
}

async function loadArticleDetail(id: string): Promise<void> {
  if (state.loadingDetails.has(id)) return;
  const generation = state.feedGeneration;
  state.loadingDetails.add(id);
  state.detailErrors.delete(id);
  render();
  try {
    const article = await request<Article>(`/api/articles/${encodeURIComponent(id)}`);
    if (generation !== state.feedGeneration) return;
    state.fullArticles.set(id, article);
    state.expandedIds.add(id);
  } catch (error) {
    if (generation !== state.feedGeneration) return;
    if (error instanceof RevisionMismatchError) state.revisionMismatch = true;
    else state.detailErrors.set(id, errorMessage(error));
  } finally {
    if (generation === state.feedGeneration) {
      state.loadingDetails.delete(id);
      render();
    }
  }
}

function loadOlderWindow(): void {
  const olderWindow = startOlderWindow<Article>(state.cursor);
  if (!olderWindow || state.loadingFeed) return;
  resetScrollOnRender = true;
  feedController?.abort();
  state.feedGeneration += 1;
  state.articles = olderWindow.items;
  state.cursor = olderWindow.cursor;
  state.loadingFeed = false;
  state.feedError = null;
  state.revisionMismatch = false;
  state.expandedIds.clear();
  state.loadingDetails.clear();
  state.detailErrors.clear();
  state.fullArticles.clear();
  void loadFeed();
}

function focusMenuButton(): void {
  app?.querySelector<HTMLButtonElement>('.menu-button')?.focus();
}

function closeDrawer(): void {
  state.channelDrawerOpen = false;
  render();
  focusMenuButton();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '通信に失敗しました。';
}

function dateLabel(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '日時不明';
  return new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function articleMarkup(article: Article): string {
  const expanded = state.expandedIds.has(article.id);
  const detail = state.fullArticles.get(article.id);
  const displayed = detail ?? article;
  const isLoadingDetail = state.loadingDetails.has(article.id);
  const detailError = state.detailErrors.get(article.id);
  const tags = article.tags.map((name) => `<button class="inline-tag" data-action="select-tag" data-tag="${escapeHtml(name)}"># ${escapeHtml(name)}</button>`).join('');
  const bodyHtml = safeMarkdown(displayed.body);
  let body = `<div class="article-body${expanded ? ' expanded' : ''}">${bodyHtml}</div>`;
  if (article.truncated && !detail) {
    body += `<button class="text-action" data-action="read-more" data-id="${escapeHtml(article.id)}" ${isLoadingDetail ? 'disabled' : ''}>${isLoadingDetail ? '本文を読み込み中…' : '続きを読む'}</button>`;
  } else if (!expanded) {
    body += `<button class="text-action" data-action="expand" data-id="${escapeHtml(article.id)}">続きを読む</button>`;
  } else {
    body += `<button class="text-action" data-action="collapse" data-id="${escapeHtml(article.id)}">折りたたむ</button>`;
  }
  if (detailError) body += `<div class="inline-error" role="alert">${escapeHtml(detailError)} <button data-action="read-more" data-id="${escapeHtml(article.id)}">再試行</button></div>`;
  return `<article class="post" aria-labelledby="title-${escapeHtml(article.id)}">
    <div class="avatar" aria-hidden="true">${escapeHtml((article.title || '記').slice(0, 1))}</div>
    <div class="post-content">
      <header class="post-header"><h3 id="title-${escapeHtml(article.id)}">${escapeHtml(article.title || '無題')}</h3><time datetime="${escapeHtml(article.createdAt)}">${escapeHtml(dateLabel(article.createdAt))}</time></header>
      <div class="post-meta"><span class="folder-label"># ${escapeHtml(article.folder)}</span>${article.updatedAt !== article.createdAt ? `<span>更新 ${escapeHtml(dateLabel(article.updatedAt))}</span>` : ''}</div>
      ${body}${attachmentMarkup(displayed)}
      ${tags ? `<div class="post-tags">${tags}</div>` : ''}
    </div>
  </article>`;
}

function render(): void {
  if (!app) return;
  const feedScroll = resetScrollOnRender ? 0 : app.querySelector<HTMLElement>('#feed-scroll')?.scrollTop ?? 0;
  const sidebarScroll = app.querySelector<HTMLElement>('.sidebar')?.scrollTop ?? 0;
  resetScrollOnRender = false;
  const searchInput = app.querySelector<HTMLInputElement>('#search-input');
  const searchDraft = renderedQuery === state.query ? searchInput?.value : undefined;
  const searchFocused = document.activeElement === searchInput;
  const selection = searchFocused ? [searchInput?.selectionStart ?? 0, searchInput?.selectionEnd ?? 0] : null;
  const oldPosts = new Map(Array.from(app.querySelectorAll<HTMLElement>('.post')).map(post => [post.getAttribute('aria-labelledby'), post]));
  const channelRows = state.channels.items.map((channel) => `<button class="channel-row${state.folder === channel.folder ? ' selected' : ''}" data-action="select-folder" data-folder="${escapeHtml(channel.folder)}">
    <span class="channel-hash">#</span><span class="channel-name">${escapeHtml(channel.folder)}</span><span class="channel-count">${channel.count}</span>
  </button>`).join('');
  const tagOptions = state.tags.items.map((tag) => `<button class="tag-option${state.tag === tag.name ? ' selected' : ''}" data-action="select-tag" data-tag="${escapeHtml(tag.name)}"># ${escapeHtml(tag.name)} <span>${tag.count}</span></button>`).join('');
  const filtered = state.folder || state.tag || state.query;
  const articleContent = state.articles.map(articleMarkup).join('');
  const noMore = state.cursor === null && !state.loadingFeed && state.articles.length > 0;
  const hasNoResults = !state.loadingFeed && !state.feedError && !state.revisionMismatch && !state.articles.length;
  const template = document.createElement('template');
  template.innerHTML = `<div class="app-shell">
    <aside class="sidebar${state.channelDrawerOpen ? ' drawer-open' : ''}" id="channel-panel" aria-label="チャンネル">
      <div class="sidebar-head"><div class="brand-mark">f</div><div><p class="eyebrow">PRIVATE VAULT</p><h1>Fragment View</h1></div><button class="icon-button close-drawer" data-action="close-drawer" aria-label="チャンネルを閉じる">×</button></div>
      <div class="area-switch" role="group" aria-label="記事の範囲">
        <button data-action="area" data-area="active" aria-pressed="${state.area === 'active'}">進行中</button>
        <button data-action="area" data-area="archive" aria-pressed="${state.area === 'archive'}">アーカイブ</button>
      </div>
      <div class="sidebar-section"><div class="section-heading"><span>フォルダ</span><span class="section-count">${state.channels.items.length}${state.channels.cursor ? '+' : ''}</span></div>
        <button class="channel-row${state.folder === null ? ' selected' : ''}" data-action="select-folder" data-folder=""><span class="channel-hash">⌂</span><span class="channel-name">すべての記事</span></button>
        ${channelRows || (state.channels.loading ? '<p class="side-note">読み込み中…</p>' : '<p class="side-note">フォルダはありません</p>')}
        ${state.channels.error ? `<p class="side-error">${escapeHtml(state.channels.error)}</p><button class="subtle-button" data-action="load-channels">再試行</button>` : ''}
        ${state.channels.cursor ? `<button class="subtle-button" data-action="load-channels" ${state.channels.loading ? 'disabled' : ''}>${state.channels.loading ? '読み込み中…' : 'フォルダをもっと見る'}</button>` : ''}
      </div>
      <div class="sidebar-section tags-section"><div class="section-heading"><span>タグ</span><span class="section-count">${state.tags.items.length}${state.tags.cursor ? '+' : ''}</span></div>
        ${tagOptions || (state.tags.loading ? '<p class="side-note">読み込み中…</p>' : '<p class="side-note">タグはありません</p>')}
        ${state.tags.error ? `<p class="side-error">${escapeHtml(state.tags.error)}</p><button class="subtle-button" data-action="load-tags">再試行</button>` : ''}
        ${state.tags.cursor ? `<button class="subtle-button" data-action="load-tags" ${state.tags.loading ? 'disabled' : ''}>${state.tags.loading ? '読み込み中…' : 'タグをもっと見る'}</button>` : ''}
      </div>
      <div class="sidebar-foot">読み取り専用 · ${state.area === 'active' ? '進行中' : 'アーカイブ'}</div>
    </aside>
    ${state.channelDrawerOpen ? '<button class="drawer-scrim" data-action="close-drawer" aria-label="メニューを閉じる"></button>' : ''}
    <main class="main-panel">
      <header class="topbar"><button class="icon-button menu-button" data-action="open-drawer" aria-label="チャンネル一覧を開く" aria-expanded="${state.channelDrawerOpen}" aria-controls="channel-panel">☰</button>
        <div class="current-channel"><span class="channel-hash">#</span><strong>${escapeHtml(state.folder ?? 'すべての記事')}</strong><span class="area-badge">${state.area === 'active' ? '進行中' : 'アーカイブ'}</span></div>
        <span class="topbar-spacer"></span><span class="vault-status"><i></i>プライベート</span>
      </header>
      <section class="feed-toolbar"><div><p class="eyebrow">FRAGMENTBOX / ${state.area.toUpperCase()}</p><h2>${escapeHtml(state.folder ?? 'すべての記事')}</h2><p class="feed-subtitle">${state.tag ? `#${escapeHtml(state.tag)} の記事` : state.query ? `「${escapeHtml(state.query)}」の検索結果` : 'メモや記録を時系列で表示'}</p></div>
        <form class="search-form" id="search-form"><label class="sr-only" for="search-input">記事を検索</label><input id="search-input" name="q" type="search" value="${escapeHtml(state.query)}" placeholder="記事を検索…" autocomplete="off" /><button type="submit" aria-label="検索">⌕</button></form>
      </section>
      ${filtered ? `<div class="active-filters">${state.folder ? `<button data-action="clear-folder"># ${escapeHtml(state.folder)} <span>×</span></button>` : ''}${state.tag ? `<button data-action="clear-tag"># ${escapeHtml(state.tag)} <span>×</span></button>` : ''}${state.query ? `<button data-action="clear-query">検索: ${escapeHtml(state.query)} <span>×</span></button>` : ''}<button class="clear-all" data-action="clear-filters">条件をクリア</button></div>` : ''}
      <div class="feed-scroll" id="feed-scroll" aria-live="polite">
        ${state.revisionMismatch ? `<div class="notice warning" role="alert"><strong>一覧が更新されました</strong><p>記事の追加や移動があったため、ページを続けて表示できません。</p><button class="primary-button" data-action="reset-feed">最新の一覧を読み込む</button></div>` : ''}
        ${state.feedError ? `<div class="notice error" role="alert"><strong>記事を読み込めませんでした</strong><p>${escapeHtml(state.feedError)}</p><button class="primary-button" data-action="retry-feed">再試行</button></div>` : ''}
        ${hasNoResults ? `<div class="empty-state"><div class="empty-icon">⌕</div><h3>${filtered ? '記事が見つかりません' : 'まだ記事がありません'}</h3><p>${filtered ? '検索語や絞り込み条件を変えてみてください。' : '記事が同期されると、ここに表示されます。'}</p>${filtered ? '<button class="text-action" data-action="clear-filters">条件をクリア</button>' : ''}</div>` : ''}
        ${articleContent}
        ${state.loadingFeed ? '<div class="loading-row" role="status"><span class="spinner"></span>記事を読み込み中…</div>' : ''}
        ${state.articles.length >= ARTICLE_WINDOW_LIMIT ? `<div class="notice limit-notice"><strong>表示件数をいったん区切りました</strong><p>一度に保持する記事は${ARTICLE_WINDOW_LIMIT}件までです。${state.cursor ? '続けて古い記事を表示すると、今の一覧を入れ替えます。' : 'これより古い記事はありません。'}</p>${state.cursor ? '<button class="primary-button" data-action="load-older-window">さらに古い記事を表示</button>' : ''} <button class="text-action" data-action="reset-feed">最新から読み直す</button></div>` : ''}
        ${state.cursor && state.articles.length < ARTICLE_WINDOW_LIMIT && !state.loadingFeed && !state.revisionMismatch ? '<button class="load-more" data-action="load-more">さらに記事を読み込む</button>' : ''}
        ${noMore ? '<p class="end-of-feed">— ここまでです —</p>' : ''}
      </div>
    </main>
  </div>`;
  // Reuse unchanged cards before attaching the fragment, so loaded thumbnails
  // are not downloaded again whenever a request or filter control updates.
  for (const post of template.content.querySelectorAll<HTMLElement>('.post')) {
    const old = oldPosts.get(post.getAttribute('aria-labelledby'));
    if (old?.isEqualNode(post)) post.replaceWith(old);
  }
  app.replaceChildren(template.content);
  const newSearch = app.querySelector<HTMLInputElement>('#search-input')!;
  if (searchDraft !== undefined) newSearch.value = searchDraft;
  if (searchFocused) {
    newSearch.focus({ preventScroll: true });
    if (selection) newSearch.setSelectionRange(selection[0], selection[1]);
  }
  app.querySelector<HTMLElement>('#feed-scroll')!.scrollTop = feedScroll;
  app.querySelector<HTMLElement>('.sidebar')!.scrollTop = sidebarScroll;
  renderedQuery = state.query;
}

app.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'area') {
    const area = target.dataset.area as Area;
    if (state.area === area) return;
    state.area = area;
    metadataControllers.forEach((entry) => entry.controller.abort());
    metadataControllers = [];
    state.folder = null;
    state.tag = null;
    state.channels = emptyMetadata();
    state.tags = emptyMetadata();
    resetFeed();
    void loadMetadata('channels', true);
    void loadMetadata('tags', true);
  } else if (action === 'select-folder') {
    const restoreFocus = state.channelDrawerOpen;
    state.folder = target.dataset.folder || null;
    state.channelDrawerOpen = false;
    resetFeed();
    if (restoreFocus) focusMenuButton();
  } else if (action === 'select-tag') {
    const restoreFocus = state.channelDrawerOpen;
    const tag = target.dataset.tag ?? null;
    state.tag = state.tag === tag ? null : tag;
    state.channelDrawerOpen = false;
    resetFeed();
    if (restoreFocus) focusMenuButton();
  } else if (action === 'clear-tag') { state.tag = null; resetFeed(); }
  else if (action === 'clear-folder') { state.folder = null; resetFeed(); }
  else if (action === 'clear-query') { state.query = ''; resetFeed(); }
  else if (action === 'clear-filters') { state.folder = null; state.tag = null; state.query = ''; resetFeed(); }
  else if (action === 'load-channels') void loadMetadata('channels');
  else if (action === 'load-tags') void loadMetadata('tags');
  else if (action === 'load-more') void loadFeed();
  else if (action === 'load-older-window') loadOlderWindow();
  else if (action === 'retry-feed') void loadFeed(state.articles.length === 0);
  else if (action === 'reset-feed') resetFeed();
  else if (action === 'open-drawer') {
    state.channelDrawerOpen = true;
    render();
    app?.querySelector<HTMLButtonElement>('.close-drawer')?.focus();
  }
  else if (action === 'close-drawer') closeDrawer();
  else if (action === 'read-more') void loadArticleDetail(target.dataset.id ?? '');
  else if (action === 'expand') { state.expandedIds.add(target.dataset.id ?? ''); render(); }
  else if (action === 'collapse') { state.expandedIds.delete(target.dataset.id ?? ''); render(); }
});

app.addEventListener('submit', (event) => {
  if ((event.target as HTMLElement).id !== 'search-form') return;
  event.preventDefault();
  const restoreFocus = state.channelDrawerOpen;
  const data = new FormData(event.target as HTMLFormElement);
  state.query = String(data.get('q') ?? '').trim();
  state.channelDrawerOpen = false;
  resetFeed();
  if (restoreFocus) focusMenuButton();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.channelDrawerOpen) closeDrawer();
});

app.addEventListener('scroll', (event) => {
  const element = event.target as HTMLElement;
  if (element.id !== 'feed-scroll' || !state.cursor || state.loadingFeed || state.revisionMismatch) return;
  if (element.scrollHeight - element.scrollTop - element.clientHeight < 260) void loadFeed();
}, true);

render();
void loadMetadata('channels', true);
void loadMetadata('tags', true);
void loadFeed(true);
