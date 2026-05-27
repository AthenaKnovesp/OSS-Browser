import { useMemo } from 'react';
import { useAppStore } from './stores/appStore';
import {
  resolveLanguagePreference,
  translate,
  type MessageKey
} from '@shared/i18n';
import type { AppResolvedLanguage } from '@shared/types';

type I18nParams = Parameters<typeof translate>[2];

export interface RendererI18n {
  language: AppResolvedLanguage;
  t: (key: MessageKey, params?: I18nParams) => string;
}

export function useI18n(): RendererI18n {
  const preference = useAppStore((state) => state.config?.appearanceSettings.language);
  const language = resolveLanguagePreference(preference, navigator.language);
  return useMemo(
    () => ({
      language,
      t: (key: MessageKey, params?: I18nParams) => translate(language, key, params)
    }),
    [language]
  );
}
