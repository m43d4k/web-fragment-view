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

interface State extends FeedState {
  area: Area;
  folder: string | null;
  selectedTags: Set<string>;
  tagMode: 'AND' | 'OR';
  query: string;
  dateFrom: string;
  dateTo: string;
  channels: Metadata<Channel>;
  tags: Metadata<Tag>;
  searchOpen: boolean;
  channelDrawerOpen: boolean;
}

interface FeedState {
  articles: Article[];
  cursor: string | null;
  loadingFeed: boolean;
  feedError: string | null;
  revisionMismatch: boolean;
  feedGeneration: number;
  expandedIds: Set<string>;
  loadingDetails: Set<string>;
  detailErrors: Map<string, string>;
  fullArticles: Map<string, Article>;
  controller: AbortController | null;
  resetScroll: boolean;
}

const state: State = {
  area: 'active',
  folder: null,
  selectedTags: new Set(),
  tagMode: 'AND',
  query: '',
  dateFrom: '',
  dateTo: '',
  channels: emptyMetadata(),
  tags: emptyMetadata(),
  searchOpen: false,
  channelDrawerOpen: false,
  ...emptyFeed(),
};

function emptyFeed(): FeedState {
  return {
    articles: [],
    cursor: null,
    loadingFeed: false,
    feedError: null,
    revisionMismatch: false,
    feedGeneration: 0,
    expandedIds: new Set(),
    loadingDetails: new Set(),
    detailErrors: new Map(),
    fullArticles: new Map(),
    controller: null,
    resetScroll: false,
  };
}

const searchFeed = emptyFeed();

function emptyMetadata<T>(): Metadata<T> {
  return { items: [], cursor: null, loading: false, error: null };
}

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('アプリの表示領域がありません。');

let metadataControllers: Array<{ kind: 'channels' | 'tags'; area: Area; controller: AbortController }> = [];
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

function queryString(params: Record<string, string | string[] | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) value.forEach((item) => search.append(key, item));
    else if (value) search.set(key, value);
  }
  const result = search.toString();
  return result ? `?${result}` : '';
}

function resetOneFeed(target: FeedState): void {
  target.resetScroll = true;
  target.controller?.abort();
  target.feedGeneration += 1;
  target.articles = [];
  target.cursor = null;
  target.loadingFeed = false;
  target.feedError = null;
  target.revisionMismatch = false;
  target.expandedIds.clear();
  target.loadingDetails.clear();
  target.detailErrors.clear();
  target.fullArticles.clear();
  if (target === state || (state.searchOpen && (state.query || state.dateFrom || state.dateTo))) void loadFeed(true, target);
  else render();
}

function resetFeed(): void {
  resetOneFeed(state);
  resetOneFeed(searchFeed);
}

function closeSearch(): void {
  state.searchOpen = false;
  state.query = '';
  state.dateFrom = '';
  state.dateTo = '';
  resetOneFeed(searchFeed);
  app?.querySelector<HTMLButtonElement>('[data-action="open-search"]')?.focus();
}

function selectFolder(folder: string | null): void {
  state.folder = folder;
  state.selectedTags.clear();
  state.tags = emptyMetadata();
  resetFeed();
  void loadMetadata('tags', true);
}

async function loadMetadata<T>(kind: 'channels' | 'tags', reset = false): Promise<void> {
  const metadata = state[kind] as Metadata<T>;
  if (!reset && (metadata.loading || (metadata.cursor === null && metadata.items.length > 0))) return;
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
  const requestedFolder = kind === 'tags' ? state.folder : null;
  const isCurrent = () => !controller.signal.aborted && state[kind] === metadata && requestedArea === state.area
    && (kind !== 'tags' || requestedFolder === state.folder);
  metadataControllers.push({ kind, area: requestedArea, controller });
  const params = { area: requestedArea, folder: requestedFolder, cursor: metadata.cursor };
  try {
    const page = await request<Page<T>>(`/api/${kind}${queryString(params)}`, controller.signal);
    if (!isCurrent()) return;
    metadata.items = [...metadata.items, ...page.items];
    metadata.cursor = page.nextCursor;
  } catch (error) {
    if (!isCurrent()) return;
    if (error instanceof RevisionMismatchError) {
      metadata.items = [];
      metadata.cursor = null;
      metadata.error = '一覧が更新されました。最新のフォルダ・タグを再取得してください。';
    } else if (!(error instanceof DOMException && error.name === 'AbortError')) metadata.error = errorMessage(error);
  } finally {
    metadataControllers = metadataControllers.filter(entry => entry.controller !== controller);
    if (isCurrent()) {
      metadata.loading = false;
      render();
    }
  }
}

async function loadFeed(firstPage = false, target: FeedState = state): Promise<void> {
  if (target.loadingFeed || target.revisionMismatch || target.articles.length >= ARTICLE_WINDOW_LIMIT) return;
  if (!firstPage && target.cursor === null) return;
  const generation = target.feedGeneration;
  target.controller?.abort();
  const controller = new AbortController();
  target.controller = controller;
  target.loadingFeed = true;
  target.feedError = null;
  render();
  const params = {
    area: state.area,
    folder: state.folder,
    tag: [...state.selectedTags].sort(),
    tagMode: state.tagMode,
    q: target === searchFeed ? state.query || null : null,
    dateFrom: target === searchFeed ? state.dateFrom || null : null,
    dateTo: target === searchFeed ? state.dateTo || null : null,
    cursor: firstPage ? null : target.cursor,
  };
  try {
    const page = await request<Page<Article>>(`/api/articles${queryString(params)}`, controller.signal);
    if (generation !== target.feedGeneration) return;
    target.articles = appendWithinWindow(target.articles, page.items);
    target.cursor = page.nextCursor;
  } catch (error) {
    if (generation !== target.feedGeneration) return;
    if (error instanceof RevisionMismatchError) target.revisionMismatch = true;
    else if (!(error instanceof DOMException && error.name === 'AbortError')) target.feedError = errorMessage(error);
  } finally {
    if (generation === target.feedGeneration) {
      target.loadingFeed = false;
      render();
    }
  }
}

async function loadArticleDetail(id: string, target: FeedState = state): Promise<void> {
  if (target.loadingDetails.has(id)) return;
  const generation = target.feedGeneration;
  target.loadingDetails.add(id);
  target.detailErrors.delete(id);
  render();
  try {
    const article = await request<Article>(`/api/articles/${encodeURIComponent(id)}`);
    if (generation !== target.feedGeneration) return;
    target.fullArticles.set(id, article);
    target.expandedIds.add(id);
  } catch (error) {
    if (generation !== target.feedGeneration) return;
    if (error instanceof RevisionMismatchError) target.revisionMismatch = true;
    else target.detailErrors.set(id, errorMessage(error));
  } finally {
    if (generation === target.feedGeneration) {
      target.loadingDetails.delete(id);
      render();
    }
  }
}

function loadOlderWindow(target: FeedState = state): void {
  const olderWindow = startOlderWindow<Article>(target.cursor);
  if (!olderWindow || target.loadingFeed) return;
  target.resetScroll = true;
  target.controller?.abort();
  target.feedGeneration += 1;
  target.articles = olderWindow.items;
  target.cursor = olderWindow.cursor;
  target.loadingFeed = false;
  target.feedError = null;
  target.revisionMismatch = false;
  target.expandedIds.clear();
  target.loadingDetails.clear();
  target.detailErrors.clear();
  target.fullArticles.clear();
  void loadFeed(false, target);
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

function articleMarkup(article: Article, target: FeedState = state): string {
  const expanded = target.expandedIds.has(article.id);
  const detail = target.fullArticles.get(article.id);
  const displayed = expanded ? detail ?? article : article;
  const isLoadingDetail = target.loadingDetails.has(article.id);
  const detailError = target.detailErrors.get(article.id);
  const renderedAttachments = new Set<string>();
  const bodyHtml = safeMarkdown(displayed.body, displayed, renderedAttachments);
  let body = `<div class="article-body${expanded ? ' expanded' : ''}">${bodyHtml}</div>`;
  if (article.truncated && !expanded) {
    body += `<button class="text-action" data-action="${detail ? 'expand' : 'read-more'}" data-id="${escapeHtml(article.id)}" ${isLoadingDetail ? 'disabled' : ''}>${isLoadingDetail ? '本文を読み込み中…' : '続きを読む'}</button>`;
  } else if (expanded) {
    body += `<button class="text-action" data-action="collapse" data-id="${escapeHtml(article.id)}">折りたたむ</button>`;
  }
  if (detailError) body += `<div class="inline-error" role="alert">${escapeHtml(detailError)} <button data-action="read-more" data-id="${escapeHtml(article.id)}">再試行</button></div>`;
  return `<article class="post" data-id="${escapeHtml(article.id)}" aria-label="${escapeHtml(article.title || '無題')}">
    <div class="post-content">
      <header class="post-header"><time datetime="${escapeHtml(article.createdAt)}">${escapeHtml(dateLabel(article.createdAt))}</time></header>
      ${body}${attachmentMarkup({ ...displayed, attachments: displayed.attachments.filter((item) => !renderedAttachments.has(item.id)) })}
    </div>
  </article>`;
}

const searchIcon = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>';

function feedMarkup(target: FeedState, filtered: boolean): string {
  const articleContent = target.articles.map(article => articleMarkup(article, target)).join('');
  const noMore = target.cursor === null && !target.loadingFeed && target.articles.length > 0;
  const hasNoResults = !target.loadingFeed && !target.feedError && !target.revisionMismatch && !target.articles.length;
  return `<div class="feed-scroll" id="${target === state ? 'feed-scroll' : 'search-scroll'}" aria-live="polite"><div class="feed-content">
        ${target.revisionMismatch ? `<div class="notice warning" role="alert"><strong>一覧が更新されました</strong><p>記事の追加や移動があったため、ページを続けて表示できません。</p><button class="primary-button" data-action="reset-feed">最新の一覧を読み込む</button></div>` : ''}
        ${target.feedError ? `<div class="notice error" role="alert"><strong>記事を読み込めませんでした</strong><p>${escapeHtml(target.feedError)}</p><button class="primary-button" data-action="retry-feed">再試行</button></div>` : ''}
        ${hasNoResults ? `<div class="empty-state"><div class="empty-icon">⌕</div><h3>${filtered ? '記事が見つかりません' : 'まだ記事がありません'}</h3><p>${filtered ? '検索語や絞り込み条件を変えてみてください。' : '記事が同期されると、ここに表示されます。'}</p>${filtered ? '<button class="text-action" data-action="clear-filters">条件をクリア</button>' : ''}</div>` : ''}
        ${articleContent}
        ${target.loadingFeed ? '<div class="loading-row" role="status"><span class="spinner"></span>記事を読み込み中…</div>' : ''}
        ${target.articles.length >= ARTICLE_WINDOW_LIMIT ? `<div class="notice limit-notice"><strong>表示件数をいったん区切りました</strong><p>一度に保持する記事は${ARTICLE_WINDOW_LIMIT}件までです。${target.cursor ? '続けて古い記事を表示すると、今の一覧を入れ替えます。' : 'これより古い記事はありません。'}</p>${target.cursor ? '<button class="primary-button" data-action="load-older-window">さらに古い記事を表示</button>' : ''} <button class="text-action" data-action="reset-feed">最新から読み直す</button></div>` : ''}
        ${target.cursor && target.articles.length < ARTICLE_WINDOW_LIMIT && !target.loadingFeed && !target.revisionMismatch ? '<button class="load-more" data-action="load-more">さらに記事を読み込む</button>' : ''}
        ${noMore ? '<p class="end-of-feed">— ここまでです —</p>' : ''}
      </div></div>`;
}

function render(): void {
  if (!app) return;
  const feedScroll = state.resetScroll ? 0 : app.querySelector<HTMLElement>('#feed-scroll')?.scrollTop ?? 0;
  const sidebarScroll = app.querySelector<HTMLElement>('.sidebar')?.scrollTop ?? 0;
  const searchScroll = searchFeed.resetScroll ? 0 : app.querySelector<HTMLElement>('#search-scroll')?.scrollTop ?? 0;
  state.resetScroll = false;
  searchFeed.resetScroll = false;
  const searchInput = app.querySelector<HTMLInputElement>('#search-input');
  const searchDraft = renderedQuery === state.query ? searchInput?.value : undefined;
  const searchFocused = document.activeElement === searchInput;
  const selection = searchFocused ? [searchInput?.selectionStart ?? 0, searchInput?.selectionEnd ?? 0] : null;
  const oldPosts = new Map(Array.from(app.querySelectorAll<HTMLElement>('.post')).map(post => [`${post.closest('.feed-scroll')?.id}:${post.dataset.id}`, post]));
  const channelRows = state.channels.items.map((channel) => `<button class="channel-row${state.folder === channel.folder ? ' selected' : ''}" data-action="select-folder" data-folder="${escapeHtml(channel.folder)}">
    <span class="channel-name">${escapeHtml(channel.folder)}</span><span class="channel-count">${channel.count}</span>
  </button>`).join('');
  const tagOptions = state.tags.items.map((tag) => `<button class="tag-option${state.selectedTags.has(tag.name) ? ' selected' : ''}" data-action="select-tag" data-tag="${escapeHtml(tag.name)}" aria-pressed="${state.selectedTags.has(tag.name)}"># ${escapeHtml(tag.name)} <span>${tag.count}</span></button>`).join('');
  const activeFilters = state.folder || state.selectedTags.size > 0;
  const filtered = activeFilters;
  const template = document.createElement('template');
  template.innerHTML = `<div class="app-shell">
    <aside class="sidebar${state.channelDrawerOpen ? ' drawer-open' : ''}" id="channel-panel" aria-label="チャンネル">
      <div class="sidebar-head"><div class="brand-mark">f</div><div><p class="eyebrow">PRIVATE VAULT</p><h1>Fragment View</h1></div><button class="icon-button close-drawer" data-action="close-drawer" aria-label="チャンネルを閉じる">×</button></div>
      <div class="area-switch" role="group" aria-label="記事の範囲">
        <button data-action="area" data-area="active" aria-pressed="${state.area === 'active'}">General</button>
        <button data-action="area" data-area="archive" aria-pressed="${state.area === 'archive'}">Archive</button>
      </div>
      <div class="sidebar-section"><div class="section-heading"><span>フォルダ</span><span class="section-count">${state.channels.items.length}${state.channels.cursor ? '+' : ''}</span></div>
        <button class="channel-row${state.folder === null ? ' selected' : ''}" data-action="select-folder" data-folder=""><span class="channel-hash">⌂</span><span class="channel-name">すべての記事</span></button>
        ${channelRows || (state.channels.loading ? '<p class="side-note">読み込み中…</p>' : '<p class="side-note">フォルダはありません</p>')}
        ${state.channels.error ? `<p class="side-error">${escapeHtml(state.channels.error)}</p><button class="subtle-button" data-action="load-channels">再試行</button>` : ''}
        ${state.channels.cursor ? `<button class="subtle-button" data-action="load-channels" ${state.channels.loading ? 'disabled' : ''}>${state.channels.loading ? '読み込み中…' : 'フォルダをもっと見る'}</button>` : ''}
      </div>
      <div class="sidebar-section tags-section"><div class="section-heading"><span>タグ</span><span class="section-count">${state.tags.items.length}${state.tags.cursor ? '+' : ''}</span></div>
        <div class="tag-controls"><button class="tag-mode-button" data-action="toggle-tag-mode" aria-label="タグ条件: ${state.tagMode === 'AND' ? 'すべて含む' : 'いずれかを含む'}。クリックで切り替え">${state.tagMode}</button><button class="tag-mode-button" data-action="clear-tags" aria-label="タグの選択をすべて解除" ${state.selectedTags.size === 0 ? 'disabled' : ''}>選択解除</button></div>
        ${tagOptions || (state.tags.loading ? '<p class="side-note">読み込み中…</p>' : '<p class="side-note">タグはありません</p>')}
        ${state.tags.error ? `<p class="side-error">${escapeHtml(state.tags.error)}</p><button class="subtle-button" data-action="load-tags">再試行</button>` : ''}
        ${state.tags.cursor ? `<button class="subtle-button" data-action="load-tags" ${state.tags.loading ? 'disabled' : ''}>${state.tags.loading ? '読み込み中…' : 'タグをもっと見る'}</button>` : ''}
      </div>
      <div class="sidebar-foot">読み取り専用 · ${state.area === 'active' ? 'General' : 'Archive'}</div>
    </aside>
    ${state.channelDrawerOpen ? '<button class="drawer-scrim" data-action="close-drawer" aria-label="メニューを閉じる"></button>' : ''}
    <main class="main-panel">
      <header class="topbar"><button class="icon-button menu-button" data-action="open-drawer" aria-label="チャンネル一覧を開く" aria-expanded="${state.channelDrawerOpen}" aria-controls="channel-panel">☰</button>
        <div class="current-channel"><strong>${escapeHtml(state.folder ?? 'すべての記事')}</strong><span class="area-badge">${state.area === 'active' ? 'General' : 'Archive'}</span></div>
        <span class="topbar-spacer"></span><span class="vault-status"><i></i>プライベート</span><button class="icon-button search-toggle" data-action="open-search" aria-label="記事検索を開く" aria-expanded="${state.searchOpen}" aria-controls="search-panel">${searchIcon}</button>
      </header>
      ${activeFilters ? `<div class="active-filters">${state.folder ? `<button data-action="clear-folder">${escapeHtml(state.folder)} <span>×</span></button>` : ''}${[...state.selectedTags].map((tag) => `<button data-action="clear-tag" data-tag="${escapeHtml(tag)}" aria-label="${escapeHtml(tag)} の絞り込みを解除"># ${escapeHtml(tag)} <span>×</span></button>`).join('')}<button class="clear-all" data-action="clear-filters">条件をクリア</button></div>` : ''}
      ${feedMarkup(state, Boolean(filtered))}
    </main>
    ${state.searchOpen ? `<section class="search-panel" id="search-panel" aria-label="記事検索">
      <header class="topbar search-heading"><button class="icon-button search-back" data-action="close-search" aria-label="検索を終了">&lt;</button><div class="current-channel"><strong>${escapeHtml(state.folder ?? 'すべての記事')}</strong></div><span class="topbar-spacer"></span><button class="icon-button search-close" data-action="close-search" aria-label="検索を終了">×</button></header>
      <div class="search-controls"><form class="search-form" id="search-form"><label class="sr-only" for="search-input">記事を検索</label><input id="search-input" name="q" type="search" value="${escapeHtml(state.query)}" placeholder="記事を検索…" autocomplete="off" /><button type="submit" aria-label="検索">${searchIcon}</button></form>
        <div class="date-filter" role="group" aria-label="記事の期間（日本時間）">
          <label class="sr-only" for="date-from">開始日（日本時間）</label><input id="date-from" type="date" value="${escapeHtml(state.dateFrom)}" aria-label="開始日（日本時間）" />
          <span aria-hidden="true">〜</span>
          <label class="sr-only" for="date-to">終了日（日本時間）</label><input id="date-to" type="date" value="${escapeHtml(state.dateTo)}" aria-label="終了日（日本時間）" />
          ${state.dateFrom || state.dateTo ? '<button type="button" data-action="clear-dates" aria-label="期間の絞り込みを解除" title="期間を解除">×</button>' : ''}
        </div>
      </div>
      ${state.query || state.dateFrom || state.dateTo ? feedMarkup(searchFeed, true) : '<div class="empty-state"><h3>記事を検索</h3><p>検索する言葉や期間を指定してください。</p></div>'}
    </section>` : ''}
  </div>`;
  // Reuse unchanged cards before attaching the fragment, so loaded thumbnails
  // are not downloaded again whenever a request or filter control updates.
  for (const post of template.content.querySelectorAll<HTMLElement>('.post')) {
    const old = oldPosts.get(`${post.closest('.feed-scroll')?.id}:${post.dataset.id}`);
    if (old?.isEqualNode(post)) post.replaceWith(old);
  }
  app.replaceChildren(template.content);
  const newSearch = app.querySelector<HTMLInputElement>('#search-input')!;
  if (newSearch && searchDraft !== undefined) newSearch.value = searchDraft;
  if (newSearch && searchFocused) {
    newSearch.focus({ preventScroll: true });
    if (selection) newSearch.setSelectionRange(selection[0], selection[1]);
  }
  app.querySelector<HTMLElement>('#feed-scroll')!.scrollTop = feedScroll;
  const searchScroller = app.querySelector<HTMLElement>('#search-scroll');
  if (searchScroller) searchScroller.scrollTop = searchScroll;
  app.querySelector<HTMLElement>('.sidebar')!.scrollTop = sidebarScroll;
  renderedQuery = state.query;
}

app.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  const feed = target.closest('#search-panel') ? searchFeed : state;
  if (action === 'area') {
    const area = target.dataset.area as Area;
    if (state.area === area) return;
    state.area = area;
    metadataControllers.forEach((entry) => entry.controller.abort());
    metadataControllers = [];
    state.folder = null;
    state.selectedTags.clear();
    state.channels = emptyMetadata();
    state.tags = emptyMetadata();
    resetFeed();
    void loadMetadata('channels', true);
    void loadMetadata('tags', true);
  } else if (action === 'select-folder') {
    const restoreFocus = state.channelDrawerOpen;
    state.channelDrawerOpen = false;
    selectFolder(target.dataset.folder || null);
    if (restoreFocus) focusMenuButton();
  } else if (action === 'select-tag') {
    const tag = target.dataset.tag;
    if (!tag) return;
    if (state.selectedTags.has(tag)) state.selectedTags.delete(tag);
    else state.selectedTags.add(tag);
    resetFeed();
  } else if (action === 'toggle-tag-mode') {
    state.tagMode = state.tagMode === 'AND' ? 'OR' : 'AND';
    resetFeed();
  } else if (action === 'clear-tags') {
    state.selectedTags.clear();
    resetFeed();
  } else if (action === 'clear-tag') {
    state.selectedTags.delete(target.dataset.tag ?? '');
    resetFeed();
  }
  else if (action === 'clear-folder') selectFolder(null);
  else if (action === 'open-search') { state.searchOpen = true; render(); app?.querySelector<HTMLInputElement>('#search-input')?.focus(); }
  else if (action === 'close-search') closeSearch();
  else if (action === 'clear-filters') { state.query = ''; state.dateFrom = ''; state.dateTo = ''; selectFolder(null); }
  else if (action === 'clear-dates') { state.dateFrom = ''; state.dateTo = ''; resetOneFeed(searchFeed); }
  else if (action === 'load-channels') void loadMetadata('channels');
  else if (action === 'load-tags') void loadMetadata('tags');
  else if (action === 'load-more') void loadFeed(false, feed);
  else if (action === 'load-older-window') loadOlderWindow(feed);
  else if (action === 'retry-feed') void loadFeed(feed.articles.length === 0, feed);
  else if (action === 'reset-feed') resetOneFeed(feed);
  else if (action === 'open-drawer') {
    state.channelDrawerOpen = true;
    render();
    app?.querySelector<HTMLButtonElement>('.close-drawer')?.focus();
  }
  else if (action === 'close-drawer') closeDrawer();
  else if (action === 'read-more') void loadArticleDetail(target.dataset.id ?? '', feed);
  else if (action === 'expand') { feed.expandedIds.add(target.dataset.id ?? ''); render(); }
  else if (action === 'collapse') { feed.expandedIds.delete(target.dataset.id ?? ''); render(); }
});

app.addEventListener('change', (event) => {
  const input = event.target as HTMLInputElement;
  if (input.id !== 'date-from' && input.id !== 'date-to') return;
  if (input.id === 'date-from') state.dateFrom = input.value;
  else state.dateTo = input.value;
  resetOneFeed(searchFeed);
});

app.addEventListener('submit', (event) => {
  if ((event.target as HTMLElement).id !== 'search-form') return;
  event.preventDefault();
  const restoreFocus = state.channelDrawerOpen;
  const data = new FormData(event.target as HTMLFormElement);
  state.query = String(data.get('q') ?? '').trim();
  state.channelDrawerOpen = false;
  resetOneFeed(searchFeed);
  if (restoreFocus) focusMenuButton();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (state.channelDrawerOpen) closeDrawer();
  else if (state.searchOpen) closeSearch();
});

app.addEventListener('scroll', (event) => {
  const element = event.target as HTMLElement;
  if (element.id !== 'feed-scroll' && element.id !== 'search-scroll') return;
  const feed = element.id === 'search-scroll' ? searchFeed : state;
  if (!feed.cursor || feed.loadingFeed || feed.revisionMismatch) return;
  if (element.scrollHeight - element.scrollTop - element.clientHeight < 260) void loadFeed(false, feed);
}, true);

render();
void loadMetadata('channels', true);
void loadMetadata('tags', true);
void loadFeed(true);
