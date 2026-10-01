import { Marked, marked } from 'marked';
import DOMPurify from 'dompurify';
import type { Article } from '../shared/types';
import { tagLines } from '../shared/tags';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]!);
}

function linkCards(raw: string): string | null {
  const lines = raw.trimEnd().split('\n');
  const result: string[] = [];
  let previous = 0;
  for (let i = 0; i < lines.length; i++) {
    const url = lines[i].replace(/  $/, '');
    if (!/^https?:\/\/\S+$/i.test(url)) continue;
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) continue;
    } catch { continue; }

    const metadata: Record<string, string> = {};
    let next = i + 1;
    for (; next < lines.length; next++) {
      const match = /^(title|sitename|description):\s*(.*)$/.exec(lines[next].replace(/  $/, ''));
      if (!match) break;
      metadata[match[1]] = match[2];
    }
    if (!metadata.title) continue;

    if (i > previous) result.push(marked.parse(lines.slice(previous, i).join('\n'), { breaks: true }) as string);
    const href = escapeHtml(url);
    result.push(`<div class="url-source"><a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a></div>`);
    const site = metadata.sitename ? `<div class="line-meta">${escapeHtml(metadata.sitename)}</div>` : '';
    const description = metadata.description ? `<div class="line-meta description">${escapeHtml(metadata.description)}</div>` : '';
    const images: string[] = [];
    while (next < lines.length && /^!\[[^\]]*\]\([^)]+\)$/.test(lines[next].trimEnd())) {
      images.push(lines[next].trimEnd());
      next++;
    }
    const thumbnails = images.length ? `<div class="link-thumbnails">${marked.parse(images.join('\n\n'))}</div>` : '';
    result.push(`<div class="url-block">${site}<a class="url-title" href="${href}" target="_blank" rel="noopener noreferrer">${escapeHtml(metadata.title)}</a>${description}${thumbnails}</div>`);
    i = next - 1;
    previous = next;
  }
  if (!result.length) return null;
  if (previous < lines.length) result.push(marked.parse(lines.slice(previous).join('\n'), { breaks: true }) as string);
  return result.join('');
}

export function safeMarkdown(source: string, article?: Pick<Article, 'path' | 'attachments'> & Partial<Pick<Article, 'tags' | 'truncated'>>, renderedAttachments = new Set<string>()): string {
  const lines = tagLines(source).filter(line => !article?.truncated || line.end < source.length);
  const prefix = `FRAGMENTVIEWTAG${crypto.randomUUID().replaceAll('-', '')}X`;
  const originals = new Map<string, string>();
  let prepared = source;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const marker = `${prefix}${i}Z`;
    originals.set(marker, source.slice(line.start, line.end));
    prepared = prepared.slice(0, line.start) + marker + prepared.slice(line.end);
  }
  const parser = new Marked({ breaks: true });
  parser.use({ renderer: { paragraph: (token) => linkCards(token.raw) ?? false } });
  const html = parser.parse(prepared) as string;
  const safe = DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, ALLOW_DATA_ATTR: false, FORBID_ATTR: ['style'] });
  const template = document.createElement('template');
  template.innerHTML = safe;
  template.content.querySelectorAll('picture, source, video, audio, iframe, object, embed, form, input, button, textarea, select, option, label').forEach((node) => node.remove());
  // A blank line may split the preview images into their own Markdown paragraphs.
  for (const card of template.content.querySelectorAll('.url-block')) {
    let next = card.nextElementSibling;
    while (next?.tagName === 'P' && next.querySelector('img') &&
      Array.from(next.childNodes).every((node) => node.nodeType === Node.TEXT_NODE
        ? !node.textContent?.trim() : ['IMG', 'BR'].includes(node.nodeName))) {
      const following = next.nextElementSibling;
      let thumbnails = card.querySelector('.link-thumbnails');
      if (!thumbnails) {
        thumbnails = document.createElement('div');
        thumbnails.className = 'link-thumbnails';
        card.appendChild(thumbnails);
      }
      thumbnails.appendChild(next);
      next = following;
    }
  }
  // Replace source images with new, trusted elements. Never reuse src/srcset
  // from Markdown for inline requests; only registered R2 thumbnails may load.
  for (const image of template.content.querySelectorAll('img')) {
    const source = image.getAttribute('src') ?? '';
    if (/^https?:\/\//i.test(source)) {
      const link = document.createElement('a');
      link.href = source;
      link.textContent = image.getAttribute('alt') ? `外部画像: ${image.getAttribute('alt')}` : '外部画像を開く';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      image.replaceWith(link);
      continue;
    }
    let item: Article['attachments'][number] | undefined;
    if (article) {
      try {
        const base = new URL(article.path.split('/').map(encodeURIComponent).join('/'), 'https://vault.invalid/');
        const resolved = new URL(source, base);
        if (resolved.origin === base.origin && !resolved.search && !resolved.hash) {
          item = article.attachments.find((entry) => '/' + entry.sourcePath === decodeURIComponent(resolved.pathname));
        }
      } catch { /* An unresolvable image is not an authenticated attachment. */ }
    }
    if (item?.thumbnailKey && item.mime.startsWith('image/')) {
      const link = document.createElement('a');
      link.className = 'image-preview';
      link.href = `/api/assets/${encodeURIComponent(item.id)}?variant=original`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.setAttribute('aria-label', `${item.name} の原寸を開く`);
      const thumbnail = document.createElement('img');
      thumbnail.src = `/api/assets/${encodeURIComponent(item.id)}?variant=thumbnail`;
      thumbnail.alt = image.getAttribute('alt') || item.name;
      thumbnail.setAttribute('loading', 'lazy');
      thumbnail.setAttribute('decoding', 'async');
      link.appendChild(thumbnail);
      image.replaceWith(link);
      renderedAttachments.add(item.id);
    } else {
      image.remove();
    }
  }
  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
  for (const node of textNodes) {
    const text = node.textContent ?? '';
    const matches = [...text.matchAll(new RegExp(`${prefix}\\d+Z`, 'g'))];
    if (!matches.length) continue;
    const fragment = document.createDocumentFragment();
    let previous = 0;
    for (const match of matches) {
      const original = originals.get(match[0]);
      if (original === undefined) continue;
      const index = match.index ?? 0;
      fragment.append(document.createTextNode(text.slice(previous, index)));
      let tagEnd = 0;
      for (const tag of original.matchAll(/#([\p{L}\p{N}_]+)/gu)) {
        fragment.append(document.createTextNode(original.slice(tagEnd, tag.index)));
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'inline-tag';
        button.dataset.action = 'select-tag';
        button.dataset.tag = tag[1];
        button.textContent = tag[0];
        fragment.append(button);
        tagEnd = tag.index! + tag[0].length;
      }
      fragment.append(document.createTextNode(original.slice(tagEnd)));
      previous = index + match[0].length;
    }
    fragment.append(document.createTextNode(text.slice(previous)));
    node.replaceWith(fragment);
  }
  return template.innerHTML;
}
