export type Area = 'active' | 'archive';

export interface Attachment {
  id: string;
  name: string;
  sourcePath: string;
  mime: string;
  size: number;
  originalKey: string;
  thumbnailKey: string | null;
}

export interface Article {
  id: string;
  path: string;
  area: Area;
  folder: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  body: string;
  tags: string[];
  attachments: Attachment[];
  truncated: boolean;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  revision: number;
}

export interface Channel { area: Area; folder: string; count: number }
export interface Tag { name: string; count: number }
export interface ApiError { error: string; code: string }

export interface SyncArticle extends Omit<Article, 'truncated'> {
  hash: string;
  searchText: string;
  searchTokens: string;
}
