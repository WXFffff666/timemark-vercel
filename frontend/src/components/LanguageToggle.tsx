import { useI18n } from '@/i18n';

/**
 * Minimal language switcher driven by `useI18n` — a component that re-renders
 * when the language changes. It intentionally shows language names (`EN` /
 * `中文`), not translated UI copy, and is not mounted into the shell yet so no
 * layout is restyled by the i18n rollout (see todo 39 evidence).
 */
export function LanguageToggle({ className }: { className?: string }) {
  const { lang, setLang } = useI18n();
  const next = lang === 'zh' ? 'en' : 'zh';

  return (
    <button
      type="button"
      aria-label="Language"
      data-testid="language-toggle"
      className={className}
      onClick={() => setLang(next)}
    >
      {lang === 'zh' ? 'EN' : '中文'}
    </button>
  );
}
