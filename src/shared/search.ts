// ASCII FTS tokens allow Japanese substring search without a language dictionary.
export const normalizeSearch = (text: string): string => text.normalize('NFKC').toLowerCase();

function token(chars: string[]): string {
  return 'u' + chars.map(char => char.codePointAt(0)!.toString(16)).join('x');
}

export function searchTokens(text: string): string {
  const chars = Array.from(normalizeSearch(text));
  const tokens = new Set<string>();
  for (let i = 0; i < chars.length; i++) {
    if (!/\s/u.test(chars[i])) tokens.add(token([chars[i]]));
    if (i + 1 < chars.length && !/\s/u.test(chars[i] + chars[i + 1])) {
      tokens.add(token([chars[i], chars[i + 1]]));
    }
  }
  return [...tokens].join(' ');
}

export function searchQuery(input: string): { terms: string[]; match: string } {
  const terms = normalizeSearch(input).trim().split(/\s+/u).filter(Boolean);
  if (Array.from(input).length > 100 || terms.length > 8) throw new Error('検索語は100文字、8語以内にしてください。');
  const tokens = new Set<string>();
  for (const term of terms) {
    const chars = Array.from(term);
    if (chars.length === 1) tokens.add(token(chars));
    else for (let i = 0; i < chars.length - 1; i++) tokens.add(token(chars.slice(i, i + 2)));
  }
  return { terms, match: [...tokens].map(value => `"${value}"`).join(' AND ') };
}
