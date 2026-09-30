import { marked } from 'marked';
import DOMPurify from 'dompurify';

export function safeMarkdown(source: string): string {
  const html = marked.parse(source) as string;
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
  return template.innerHTML;
}
