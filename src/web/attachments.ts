import type { Article } from '../shared/types';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]!);
}

function assetUrl(id: string, variant: 'thumbnail' | 'original'): string {
  return `/api/assets/${encodeURIComponent(id)}?variant=${variant}`;
}

export function attachmentMarkup(article: Article): string {
  if (!article.attachments.length) return '';
  return `<section class="attachments" aria-label="添付ファイル">
    <h4>添付ファイル <span>${article.attachments.length}</span></h4>
    <ul>${article.attachments.map((item) => {
      const image = item.mime.startsWith('image/') && item.thumbnailKey
        ? `<img src="${assetUrl(item.id, 'thumbnail')}" alt="${escapeHtml(item.name)}" loading="lazy" />`
        : '<span class="file-icon" aria-hidden="true">▧</span>';
      return `<li><a class="attachment" href="${assetUrl(item.id, 'original')}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(item.name)} を開く">
        ${image}<span class="attachment-name">${escapeHtml(item.name)}</span><span class="open-icon" aria-hidden="true">↗</span>
      </a></li>`;
    }).join('')}</ul>
    <p class="attachment-hint">タップすると原本を開きます</p>
  </section>`;
}
