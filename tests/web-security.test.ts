// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { Article } from '../src/shared/types';
import { attachmentMarkup } from '../src/web/attachments';
import { appendWithinWindow, ARTICLE_WINDOW_LIMIT, startOlderWindow } from '../src/web/feed-window';
import { safeMarkdown } from '../src/web/markdown';

describe('safeMarkdown', () => {
  it('removes executable markup, unsafe links, and embedded image fetches', () => {
    const html = safeMarkdown([
      '<script>document.body.dataset.compromised = "true"</script>',
      '<img src="https://outside.example/private.png">',
      '<form action="https://outside.example/collect"><input name="secret"><button>Open</button></form>',
      '![remote](https://outside.example/markdown.png)',
      '[bad](javascript:alert(1))',
    ].join('\n\n'));
    const fragment = document.createElement('template');
    fragment.innerHTML = html;

    expect(fragment.content.querySelector('script, img, iframe, form, input, button')).toBeNull();
    expect(fragment.content.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(fragment.content.querySelector('a[href="https://outside.example/markdown.png"]')?.textContent).toBe('外部画像: remote');
    expect(html).not.toContain('outside.example/collect');
    expect(html).not.toContain('document.body');
  });

  it.each(['\n', '\n\n'])('renders a matched local image after URL metadata with separator %j as a lazy thumbnail', (separator) => {
    const article = {
      path: 'active/notes/1.md',
      attachments: [{
        id: 'image/test', name: 'test.png', sourcePath: 'assets/test.png', mime: 'image/png', size: 4,
        originalKey: 'private/original', thumbnailKey: 'private/thumb',
      }],
    } as Article;
    const renderedAttachments = new Set<string>();
    const html = safeMarkdown(`https://example.com\ntitle: Example${separator}![preview](../../assets/test.png)`, article, renderedAttachments);
    const template = document.createElement('template');
    template.innerHTML = html;
    const card = template.content.querySelector('.url-block');
    const image = card?.querySelector<HTMLImageElement>('img');

    expect(image?.getAttribute('src')).toBe('/api/assets/image%2Ftest?variant=thumbnail');
    expect(image?.getAttribute('loading')).toBe('lazy');
    expect(image?.parentElement?.getAttribute('href')).toBe('/api/assets/image%2Ftest?variant=original');
    expect(renderedAttachments).toEqual(new Set(['image/test']));
  });

  it('does not fetch unmatched local images and leaves fenced image syntax literal', () => {
    const article = {
      path: 'active/notes/1.md',
      attachments: [{ id: 'image/test', name: 'test.png', sourcePath: 'assets/test.png', mime: 'image/png', size: 4 }],
    } as Article;
    const html = safeMarkdown('![unmatched](../../assets/private.png)\n\n```markdown\n![fenced](../../assets/test.png)\n```', article, new Set());
    const template = document.createElement('template');
    template.innerHTML = html;

    expect(template.content.querySelector('img')).toBeNull();
    expect(template.content.querySelector('pre')?.textContent).toContain('![fenced](../../assets/test.png)');
    expect(html).not.toContain('/api/assets/');
  });

  it('keeps ordinary Markdown formatting and same-origin article links', () => {
    const html = safeMarkdown('## 見出し\n\n本文と [記事](./other-article)');
    expect(html).toContain('<h2>見出し</h2>');
    expect(html).toContain('href="./other-article"');
  });

  it('keeps tags at their source positions and leaves code and links untouched', () => {
    const html = safeMarkdown('前 #本文 後 [#link](https://example.com/#anchor) `#inline`\n#日本語_1 #next\n\n```text\n#fenced\n```');
    const template = document.createElement('template');
    template.innerHTML = html;
    const tag = template.content.querySelector<HTMLButtonElement>('[data-action="select-tag"]');
    expect(tag?.textContent).toBe('#日本語_1');
    expect(tag?.dataset.tag).toBe('日本語_1');
    expect(tag?.parentElement?.textContent).toContain('前 #本文 後');
    expect(template.content.querySelectorAll('[data-action]')).toHaveLength(2);
    expect(tag?.parentElement?.querySelector('br + button')?.textContent).toBe('#日本語_1');
    expect(template.content.querySelector('a')?.textContent).toBe('#link');
    expect(template.content.querySelector('code')?.textContent).toBe('#inline');
    expect(template.content.querySelector('pre')?.textContent).toContain('#fenced');
  });

  it('ignores body hashes and non-tag metadata even when the same tag exists elsewhere', () => {
    const source = '本文 #音楽\nhttps://example.com/#音楽\ntitle: #音楽\nsitename: #制作\ndescription: #説明\n\n# 見出し\n\n#音楽 #制作';
    const template = document.createElement('template');
    template.innerHTML = safeMarkdown(source);
    expect([...template.content.querySelectorAll('[data-action="select-tag"]')].map(node => node.textContent)).toEqual(['#音楽', '#制作']);
    expect(template.content.textContent).toContain('本文 #音楽');
  });

  it('does not promote an incomplete last line in a truncated article to tags', () => {
    const template = document.createElement('template');
    template.innerHTML = safeMarkdown('#音楽\n\n#制', { path: 'active/test/a.md', attachments: [], tags: ['音楽', '制作'], truncated: true });
    expect([...template.content.querySelectorAll('[data-action="select-tag"]')].map(node => node.textContent)).toEqual(['#音楽']);
    expect(template.content.textContent).toContain('#制');
  });

  it('renders a contiguous URL metadata group as a safe link card', () => {
    const html = safeMarkdown('https://example.com/a?x=1&y=2\ntitle: <img src=x onerror=alert(1)> **Title**\nsitename: Site\ndescription: A & B\n\n#tag');
    const template = document.createElement('template');
    template.innerHTML = html;
    const source = template.content.querySelector<HTMLAnchorElement>('.url-source a');
    const card = template.content.querySelector('.url-block');
    expect(source?.textContent).toBe('https://example.com/a?x=1&y=2');
    expect(source?.getAttribute('href')).toBe('https://example.com/a?x=1&y=2');
    expect(card?.querySelector('.url-title')?.textContent).toBe('<img src=x onerror=alert(1)> **Title**');
    expect(card?.querySelector('.description')?.textContent).toBe('A & B');
    expect(card?.querySelector('.line-meta')?.textContent).toBe('Site');
    expect(card?.querySelector('img, [onerror]')).toBeNull();
    expect(template.content.querySelector('[data-tag="tag"]')).not.toBeNull();
  });

  it('recognizes cards after ordinary text and Markdown hard breaks', () => {
    const html = safeMarkdown('前置き  \nhttps://one.example  \ntitle: One  \n次の行\nhttps://two.example\ntitle: Two');
    const template = document.createElement('template');
    template.innerHTML = html;
    expect([...template.content.querySelectorAll('.url-title')].map((link) => link.textContent)).toEqual(['One', 'Two']);
    expect(template.content.textContent).toContain('前置き');
    expect(template.content.textContent).toContain('次の行');
  });

  it('does not turn fenced metadata or forged actions into controls', () => {
    const html = safeMarkdown('```\nhttps://example.com\ntitle: Hidden\n#inside\n```\n\n<button data-action="select-tag" data-tag="evil">#evil</button>');
    const template = document.createElement('template');
    template.innerHTML = html;
    expect(template.content.querySelector('.url-block')).toBeNull();
    expect(template.content.querySelector('[data-action]')).toBeNull();
    expect(template.content.querySelector('pre')?.textContent).toContain('title: Hidden');
  });
});

describe('attachmentMarkup', () => {
  it('loads only a lazy thumbnail in the preview and keeps the original behind a link', () => {
    const article = {
      attachments: [{
        id: 'image/one', name: '写真.png', sourcePath: 'assets/photo.png', mime: 'image/png', size: 12,
        originalKey: 'private/original', thumbnailKey: 'private/thumb',
      }],
    } as Article;
    const template = document.createElement('template');
    template.innerHTML = attachmentMarkup(article);
    const image = template.content.querySelector('img');
    const link = template.content.querySelector('a.attachment');

    expect(image?.getAttribute('src')).toBe('/api/assets/image%2Fone?variant=thumbnail');
    expect(image?.getAttribute('loading')).toBe('lazy');
    expect(link?.getAttribute('href')).toBe('/api/assets/image%2Fone?variant=original');
    expect(template.content.querySelector('img[src*="variant=original"]')).toBeNull();
  });
});

describe('article feed window', () => {
  it('bounds each visible window and preserves the cursor when advancing to older articles', () => {
    const firstWindow = appendWithinWindow(Array.from({ length: 90 }, (_, i) => i), Array.from({ length: 20 }, (_, i) => i + 90));
    expect(firstWindow).toHaveLength(ARTICLE_WINDOW_LIMIT);

    const nextWindow = startOlderWindow<number>('older-cursor');
    expect(nextWindow).toEqual({ items: [], cursor: 'older-cursor' });
    expect(appendWithinWindow(nextWindow!.items, [110, 111])).toEqual([110, 111]);
    expect(startOlderWindow<number>(null)).toBeNull();
  });
});
