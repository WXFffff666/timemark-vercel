import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { I18nProvider, initI18n, setLang } from '@/i18n';
import { LanguageToggle } from './LanguageToggle';

afterEach(() => {
  // Wrapped in act: the RTL cleanup hook may still have the provider mounted here.
  act(() => setLang('zh'));
});

it('switches the language from the UI and updates its own label', async () => {
  // Pre-load both layers so the click only triggers the language switch itself.
  setLang('en');
  await initI18n();
  setLang('zh');
  await initI18n();

  render(
    <I18nProvider>
      <LanguageToggle className="test-toggle" />
    </I18nProvider>,
  );

  const button = screen.getByTestId('language-toggle');
  expect(button).toHaveTextContent('EN');
  expect(button).toHaveAttribute('aria-label', 'Language');

  await act(async () => {
    await userEvent.click(button);
  });

  await screen.findByText('中文');
  expect(button).toHaveTextContent('中文');
});
