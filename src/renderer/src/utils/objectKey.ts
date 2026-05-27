import type { ObjectItem } from '@shared/types';

export function parentPrefix(prefix: string): string {
  const normalized = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const index = normalized.lastIndexOf('/');
  return index > 0 ? `${normalized.slice(0, index)}/` : '';
}

export function breadcrumbParts(prefix: string): Array<{ label: string; prefix: string }> {
  const parts = prefix.split('/').filter(Boolean);
  return parts.map((part, index) => ({
    label: part,
    prefix: `${parts.slice(0, index + 1).join('/')}/`
  }));
}

export function joinPrefix(prefix: string, name: string): string {
  const base = prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix;
  return `${base}${name}`;
}

export function normalizePrefixInput(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+/g, '/');
}

export function normalizeFolderPrefixInput(value: string): string {
  const normalized = normalizePrefixInput(value);
  return normalized && !normalized.endsWith('/') ? `${normalized}/` : normalized;
}

export function buildTargetKey(prefix: string, name: string, isFolder: boolean): string {
  const normalizedPrefix = normalizePrefixInput(prefix);
  const base =
    normalizedPrefix && !normalizedPrefix.endsWith('/') ? `${normalizedPrefix}/` : normalizedPrefix;
  return `${base}${name}${isFolder ? '/' : ''}`;
}

export function objectLeafName(object: ObjectItem): string {
  const key = object.key.endsWith('/') ? object.key.slice(0, -1) : object.key;
  return key.split('/').filter(Boolean).pop() ?? object.name;
}

export function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}
