import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatMessage,
  getLang,
  I18nProvider,
  initI18n,
  setLang,
  t,
  useI18n,
  type TranslationKey,
} from './index';

afterEach(() => {
  // Wrapped in act: the RTL cleanup hook may still have the provider mounted here.
  act(() => setLang('zh'));
});

function Probe() {
  const { lang, t: translate } = useI18n();
  return (
    <div data-testid="probe" data-lang={lang}>
      {translate('nav.dashboard')} / {translate('nav.analytics')}
    </div>
  );
}

describe('i18n resource loader', () => {
  it('returns the Chinese value for a known key in zh', async () => {
    setLang('zh');
    await initI18n();
    expect(t('nav.dashboard')).toBe('首页');
    expect(t('login.submit')).toBe('登录');
  });

  it('returns the English value after switching to en', async () => {
    setLang('en');
    await initI18n();
    expect(getLang()).toBe('en');
    expect(t('nav.dashboard')).toBe('Home');
    expect(t('login.submit')).toBe('Sign in');
  });

  it('returns the key itself for an unknown key (never undefined)', async () => {
    await initI18n();
    const unknown = 'does.not.exist' as TranslationKey;
    expect(t(unknown)).toBe('does.not.exist');
    expect(t(unknown)).not.toBeUndefined();
  });

  it('interpolates {vars} through t() and leaves unknown placeholders untouched', () => {
    expect(t('Hello {name}' as TranslationKey, { name: 'Ada' })).toBe('Hello Ada');
    expect(formatMessage('你好，{name}！', { name: '小明' })).toBe('你好，小明！');
    expect(formatMessage('{a}-{b}', { a: 'x' })).toBe('x-{b}');
  });

  it('re-renders a component when the language changes', async () => {
    // Pre-load both layers so the assertion is about the language switch, not chunk timing.
    setLang('en');
    await initI18n();
    setLang('zh');
    await initI18n();

    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('首页 / 统计'));

    act(() => {
      setLang('en');
    });
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('Home / Stats'));
    expect(screen.getByTestId('probe')).toHaveAttribute('data-lang', 'en');
  });

  it('never reads localStorage at import time and survives a throwing localStorage', async () => {
    const ownDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError: localStorage is disabled');
      },
    });

    vi.resetModules();
    try {
      const fresh = await import('./index');

      // initI18n() is the first code path allowed to touch storage.
      await fresh.initI18n();
      expect(fresh.getLang()).toBe('zh');
      expect(fresh.t('nav.dashboard')).toBe('首页');

      expect(() => fresh.setLang('en')).not.toThrow();
      await fresh.initI18n();
      expect(fresh.t('nav.dashboard')).toBe('Home');
    } finally {
      if (ownDescriptor) Object.defineProperty(window, 'localStorage', ownDescriptor);
      else Reflect.deleteProperty(window, 'localStorage');
      vi.resetModules();
    }
  });
});
