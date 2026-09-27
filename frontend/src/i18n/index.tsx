import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { TranslationKey } from './resources/zh';

/**
 * Chinese-first i18n resource loader.
 *
 * - `t(key, vars?)` is synchronous; translations are backed by lazily imported
 *   resource objects (`./resources/zh`, `./resources/en`) that are cached after
 *   the first load. Until a layer is loaded, `t` falls back to Chinese, then to
 *   the key itself — it never returns `undefined`.
 * - `setLang` keeps working for non-React callers: it persists the choice (when
 *   storage is available), loads the layer and dispatches the
 *   `timemark-lang-change` event. `useI18n` / `I18nProvider` subscribe to the
 *   same event, so React components re-render on language change.
 * - No module-level `localStorage` access: every read is lazy and guarded, so a
 *   throwing/blocked `localStorage` cannot break module evaluation.
 */

export type Lang = 'zh' | 'en';
export type { TranslationKey } from './resources/zh';
export type TranslationVars = Record<string, string | number>;

type Messages = Record<TranslationKey, string>;

export const LANG_CHANGE_EVENT = 'timemark-lang-change';
const STORAGE_KEY = 'lang';

const loaders: Record<Lang, () => Promise<Messages>> = {
  zh: async () => (await import('./resources/zh')).zh,
  en: async () => (await import('./resources/en')).en,
};

const layers: Partial<Record<Lang, Messages>> = {};
const pending = new Map<Lang, Promise<Messages>>();
const listeners = new Set<() => void>();

function subscribeResources(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyResourcesLoaded(): void {
  for (const listener of listeners) listener();
}

function load(lang: Lang): Promise<Messages> {
  const cached = layers[lang];
  if (cached) return Promise.resolve(cached);

  const inflight = pending.get(lang);
  if (inflight) return inflight;

  const promise = loaders[lang]().then((messages) => {
    layers[lang] = messages;
    pending.delete(lang);
    notifyResourcesLoaded();
    return messages;
  });
  pending.set(lang, promise);
  return promise;
}

/** Pre-load the active language. Safe to call multiple times; resolves instantly once cached. */
export async function initI18n(): Promise<void> {
  await load(getLang());
}

function readStoredLang(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private mode / blocked storage — fall back to the default language.
    return null;
  }
}

function writeStoredLang(lang: Lang): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // Best effort: the in-memory language is still updated.
  }
}

let currentLang: Lang | null = null;

export function getLang(): Lang {
  if (currentLang) return currentLang;
  currentLang = readStoredLang() === 'en' ? 'en' : 'zh';
  return currentLang;
}

function emitLangChange(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(LANG_CHANGE_EVENT));
}

/** Persist + activate a language. Non-React callers keep using this as before. */
export function setLang(lang: Lang): void {
  if (lang !== 'zh' && lang !== 'en') return;
  currentLang = lang;
  writeStoredLang(lang);
  void load(lang);
  emitLangChange();
}

/** `{var}` interpolation; unknown placeholders are left untouched. */
export function formatMessage(template: string, vars?: TranslationVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

export function t(key: TranslationKey, vars?: TranslationVars): string {
  const lang = getLang();
  const template = layers[lang]?.[key] ?? layers.zh?.[key] ?? key;
  return formatMessage(template, vars);
}

export interface I18nValue {
  lang: Lang;
  t: (key: TranslationKey, vars?: TranslationVars) => string;
  setLang: (lang: Lang) => void;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ lang: Lang; revision: number }>(() => ({
    lang: getLang(),
    revision: 0,
  }));

  useEffect(() => {
    const sync = () => setState((prev) => ({ lang: getLang(), revision: prev.revision + 1 }));
    window.addEventListener(LANG_CHANGE_EVENT, sync);
    const unsubscribe = subscribeResources(sync);
    void initI18n();
    return () => {
      window.removeEventListener(LANG_CHANGE_EVENT, sync);
      unsubscribe();
    };
  }, []);

  const value = useMemo<I18nValue>(
    () => ({ lang: state.lang, t, setLang }),
    // A new object each revision invalidates the context so consumers re-render
    // when the language or a lazily loaded layer changed.
    [state],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** React binding. Falls back to the module-level store outside a provider. */
export function useI18n(): I18nValue {
  const context = useContext(I18nContext);
  const [, forceRender] = useState(0);

  useEffect(() => {
    if (context) return;
    const rerender = () => forceRender((n) => n + 1);
    window.addEventListener(LANG_CHANGE_EVENT, rerender);
    const unsubscribe = subscribeResources(rerender);
    return () => {
      window.removeEventListener(LANG_CHANGE_EVENT, rerender);
      unsubscribe();
    };
  }, [context]);

  if (context) return context;
  return { lang: getLang(), t, setLang };
}
