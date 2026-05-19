import type { Locale } from './i18n.types';

export const SUPPORTED_LOCALES: readonly Locale[] = ['en', 'tr'];
export const DEFAULT_LOCALE: Locale = 'tr';
export const LOCALE_STORAGE_KEY = 'akis.locale';

const isSupportedLocale = (value: string): value is Locale =>
  SUPPORTED_LOCALES.includes(value as Locale);

const normalizeLocale = (value: string | null | undefined): Locale | null => {
  if (!value) {
    return null;
  }

  const base = value.toLowerCase().split('-')[0];
  return isSupportedLocale(base) ? base : null;
};

const getSafeStorage = (): Storage | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export const readPersistedLocale = (): Locale | null => {
  const storage = getSafeStorage();
  if (!storage) {
    return null;
  }

  try {
    const persisted = storage.getItem(LOCALE_STORAGE_KEY);
    return normalizeLocale(persisted);
  } catch {
    return null;
  }
};

export const persistLocale = (locale: Locale): void => {
  const storage = getSafeStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Ignore persistence issues (e.g., private mode)
  }
};

export const detectNavigatorLocale = (): Locale | null => {
  if (typeof navigator === 'undefined') {
    return null;
  }

  const candidates: string[] = [];
  if (Array.isArray(navigator.languages)) {
    candidates.push(...navigator.languages);
  }
  if (navigator.language) {
    candidates.push(navigator.language);
  }

  for (const candidate of candidates) {
    const normalized = normalizeLocale(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return null;
};

export const resolveInitialLocale = (): Locale =>
  readPersistedLocale() ?? detectNavigatorLocale() ?? DEFAULT_LOCALE;
