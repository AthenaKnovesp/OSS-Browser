import type { ObjectItem } from '@shared/types';

export function objectDisplayName(object: ObjectItem): string {
  return object.name || object.key || '';
}

export function objectIdentityKey(object: ObjectItem): string {
  return `${object.bucket}/${object.key}`;
}

export function objectRowKey(object: ObjectItem): string {
  return object.key || `${object.bucket}/${objectDisplayName(object)}`;
}

export function matchesObjectSearch(object: ObjectItem, normalizedSearch: string): boolean {
  return (
    object.key.toLowerCase().includes(normalizedSearch) ||
    object.name.toLowerCase().includes(normalizedSearch)
  );
}
