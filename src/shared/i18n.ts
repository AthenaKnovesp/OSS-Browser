import zhCNMessages from './locales/zh-CN.json';
import enUSMessages from './locales/en-US.json';
import type { AppLanguagePreference, AppResolvedLanguage } from './types';

type Primitive = string | number | boolean | undefined | null;

export const LANGUAGE_OPTIONS: Array<{
  value: AppLanguagePreference;
  labelKey: MessageKey;
}> = [
  { value: 'system', labelKey: 'language.system' },
  { value: 'zh-CN', labelKey: 'language.zhCN' },
  { value: 'en-US', labelKey: 'language.enUS' }
];

export type MessageKey = keyof typeof zhCNMessages;

const catalogs: Record<AppResolvedLanguage, Record<MessageKey, string>> = {
  'zh-CN': zhCNMessages,
  'en-US': enUSMessages
};

function normalizeLanguagePreference(value: unknown): AppLanguagePreference {
  return value === 'system' || value === 'zh-CN' || value === 'en-US' ? value : 'system';
}

export function resolveLanguagePreference(
  preference: AppLanguagePreference | undefined,
  systemLanguage?: string
): AppResolvedLanguage {
  const normalized = normalizeLanguagePreference(preference);
  if (normalized !== 'system') {
    return normalized;
  }
  return systemLanguage?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}

export function translate(
  language: AppResolvedLanguage,
  key: MessageKey,
  params?: Record<string, Primitive>
): string {
  return interpolate(catalogs[language][key] ?? zhCNMessages[key] ?? key, params);
}

function interpolate(template: string, params?: Record<string, Primitive>): string {
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    const value = params[key];
    return value === undefined || value === null ? match : String(value);
  });
}
