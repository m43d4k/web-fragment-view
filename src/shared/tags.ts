import { marked, type Token } from 'marked';

export interface TagLine {
  start: number;
  end: number;
  tags: string[];
}

const TAG_LINE = /^[ \t]*#[\p{L}\p{N}_]+(?:[ \t]+#[\p{L}\p{N}_]+)*[ \t]*$/u;
const TAG = /#([\p{L}\p{N}_]+)/gu;

function normalizedSource(source: string): { text: string; offsets: number[] } {
  let text = '';
  const offsets = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '\r') {
      if (source[index + 1] === '\n') index++;
      text += '\n';
    } else {
      text += source[index];
    }
    offsets.push(index + 1);
  }
  return { text, offsets };
}

function frontmatterEnd(text: string): number {
  const first = /^(?:\uFEFF)?(---|\+\+\+)(?:\n|$)/.exec(text);
  if (!first) return 0;
  const delimiter = first[1];
  let start = first[0].length;
  while (start < text.length) {
    const end = text.indexOf('\n', start);
    const lineEnd = end < 0 ? text.length : end;
    if (text.slice(start, lineEnd) === delimiter) return end < 0 ? text.length : end + 1;
    start = lineEnd + 1;
  }
  return text.length;
}

function inlineCodeSpans(tokens: Token[], start: number): Array<[number, number]> {
  const result: Array<[number, number]> = [];
  let cursor = start;
  for (const token of tokens) {
    if (token.type === 'codespan') result.push([cursor, cursor + token.raw.length]);
    else if ('tokens' in token && Array.isArray(token.tokens)) {
      result.push(...inlineCodeSpans(token.tokens, cursor));
    }
    cursor += token.raw.length;
  }
  return result;
}

// Offsets refer to the unchanged source, including CRLF and any surrounding whitespace.
export function tagLines(source: string): TagLine[] {
  const { text, offsets } = normalizedSource(source);
  const frontmatter = frontmatterEnd(text);
  const result: TagLine[] = [];
  let tokenStart = 0;
  for (const token of marked.lexer(text)) {
    const tokenEnd = tokenStart + token.raw.length;
    if (token.type === 'paragraph') {
      const code = inlineCodeSpans(token.tokens ?? [], tokenStart);
      let lineStart = tokenStart;
      while (lineStart < tokenEnd) {
        const newline = text.indexOf('\n', lineStart);
        const lineEnd = newline < 0 || newline > tokenEnd ? tokenEnd : newline;
        const line = text.slice(lineStart, lineEnd);
        if (lineStart >= frontmatter && TAG_LINE.test(line) &&
            !code.some(([start, end]) => lineStart < end && lineEnd > start)) {
          result.push({ start: offsets[lineStart], end: offsets[lineEnd],
            tags: [...line.matchAll(TAG)].map(match => match[1]) });
        }
        if (lineEnd === tokenEnd) break;
        lineStart = lineEnd + 1;
      }
    }
    tokenStart = tokenEnd;
  }
  return result;
}

export function extractTags(source: string): string[] {
  return [...new Set(tagLines(source).flatMap(line => line.tags))];
}
