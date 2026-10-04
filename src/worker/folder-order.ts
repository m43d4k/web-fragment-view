import configuredOrder from '../../config/folder-order.json';
import type { Area } from '../shared/types';

export function validateFolderOrder(value: unknown): Record<Area, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => key !== 'active' && key !== 'archive')) {
    throw new Error('config/folder-order.json: active / archive の配列を指定してください。');
  }
  for (const area of ['active', 'archive'] as const) {
    const names = (value as Record<string, unknown>)[area];
    if (!Array.isArray(names) || names.some(name => typeof name !== 'string' ||
        !name.trim() || name.length > 512 || name.startsWith('.') || /[/\\\x00-\x1f\x7f]/.test(name)) ||
        new Set(names).size !== names.length) {
      throw new Error(`config/folder-order.json: ${area} のフォルダ名・重複を確認してください。`);
    }
  }
  return value as Record<Area, string[]>;
}

export const folderOrder = validateFolderOrder(configuredOrder);

// Bind cursors to the deployed order without embedding the entire configuration.
export async function folderOrderVersion(names: string[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(names)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
