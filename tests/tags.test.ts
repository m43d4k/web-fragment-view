import { describe, expect, it } from 'vitest';
import { extractTags, tagLines } from '../src/shared/tags';

describe('standalone tag lines', () => {
  it('recognizes complete tag lines, preserves source offsets, and deduplicates names', () => {
    const source = '本文\r\n#音楽 #制作\r\n\r\n  #音楽 #tag_1  \r\n';
    expect(extractTags(source)).toEqual(['音楽', '制作', 'tag_1']);
    expect(tagLines(source).map(line => source.slice(line.start, line.end))).toEqual(['#音楽 #制作', '  #音楽 #tag_1  ']);
  });
  it.each([
    '本文 #音楽', 'https://example.com/#音楽', '# 見出し', '## #音楽',
    '#音楽\n===', '#音楽\n---', 'title: #音楽', 'sitename: #音楽', 'description: #音楽',
    'date: #音楽', 'tags: #音楽', '![#音楽](https://example.com/a.png)', '[#音楽](https://example.com)',
    '```md\n#音楽\n```', '~~~\n#音楽\n~~~', '    #音楽', '\t#音楽',
    '`#音楽`', '`start\n#音楽\nend`', '**`start\n#音楽\nend`**',
    '> #音楽', '- #音楽', '<div>\n#音楽\n</div>', '<span>\n#音楽\n</span>',
    '---\ntitle: example\n#音楽\n---', '+++\ntitle = "example"\n#音楽\n+++',
  ])('does not recognize non-tag context: %j', source => {
    expect(extractTags(source)).toEqual([]);
  });
  it('keeps offsets correct after link definitions and excluded blocks', () => {
    const source = '[ref]: https://example.com\n\n#音楽\n\n```\n#制作\n```\n\n#制作';
    expect(extractTags(source)).toEqual(['音楽', '制作']);
    expect(tagLines(source).map(line => source.slice(line.start, line.end))).toEqual(['#音楽', '#制作']);
  });
  it('accepts tag lines following frontmatter without recognizing metadata', () => {
    expect(extractTags('---\ntitle: example\n#ignored\n---\n\n#音楽')).toEqual(['音楽']);
  });
});
