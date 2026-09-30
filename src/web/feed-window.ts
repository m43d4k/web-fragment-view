export const ARTICLE_WINDOW_LIMIT = 100;

export function appendWithinWindow<T>(current: T[], incoming: T[]): T[] {
  return [...current, ...incoming].slice(0, ARTICLE_WINDOW_LIMIT);
}

export function startOlderWindow<T>(cursor: string | null): { items: T[]; cursor: string } | null {
  return cursor ? { items: [], cursor } : null;
}
