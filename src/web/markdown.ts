import { Marked, marked } from 'marked';
import DOMPurify from 'dompurify';

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
    result.push(`<div class="url-block">${site}<a class="url-title" href="${href}" target="_blank" rel="noopener noreferrer">${escapeHtml(metadata.title)}</a>${description}</div>`);
    i = next - 1;
    previous = next;
  }
  if (!result.length) return null;
  if (previous < lines.length) result.push(marked.parse(lines.slice(previous).join('\n'), { breaks: true }) as string);
  return result.join('');
}

export function safeMarkdown(source: string): string {
  const parser = new Marked({ breaks: true });
  parser.use({ renderer: { paragraph: (token) => linkCards(token.raw) ?? false } });
  const html = parser.parse(source) as string;
  const safe = DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, ALLOW_DATA_ATTR: false, FORBID_ATTR: ['style'] });
  const template = document.createElement('template');
  template.innerHTML = safe;
  // Keep remote images accessible as explicit links, without loading them while
  // reading. Local assets are offered by the authenticated attachment list.
  for (const image of template.content.querySelectorAll('img')) {
    const source = image.getAttribute('src') ?? '';
    if (/^https?:\/\//i.test(source)) {
      const link = document.createElement('a');
      link.href = source;
      link.textContent = image.getAttribute('alt') ? `外部画像: ${image.getAttribute('alt')}` : '外部画像を開く';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      image.replaceWith(link);
    }
  }
  template.content.querySelectorAll('img, picture, source, video, audio, iframe, object, embed, form, input, button, textarea, select, option, label').forEach((node) => node.remove());
  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
  for (const node of textNodes) {
    if (node.parentElement?.closest('a, code, pre, .url-block')) continue;
    const text = node.textContent ?? '';
    const matches = [...text.matchAll(/#([\p{L}\p{N}_]+)/gu)];
    if (!matches.length) continue;
    const fragment = document.createDocumentFragment();
    let previous = 0;
    for (const match of matches) {
      const index = match.index ?? 0;
      fragment.append(document.createTextNode(text.slice(previous, index)));
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'inline-tag';
      button.dataset.action = 'select-tag';
      button.dataset.tag = match[1];
      button.textContent = match[0];
      fragment.append(button);
      previous = index + match[0].length;
    }
    fragment.append(document.createTextNode(text.slice(previous)));
    node.replaceWith(fragment);
  }
  return template.innerHTML;
}
