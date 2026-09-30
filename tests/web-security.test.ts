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

  it('keeps ordinary Markdown formatting and same-origin article links', () => {
    const html = safeMarkdown('## 見出し\n\n本文と [記事](./other-article)');
    expect(html).toContain('<h2>見出し</h2>');
    expect(html).toContain('href="./other-article"');
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
