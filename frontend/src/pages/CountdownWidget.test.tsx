import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { clearEventOgMeta } from '@/lib/og-meta';
import CountdownWidget from './CountdownWidget';

function renderAt(token: string) {
  return render(
    <MemoryRouter initialEntries={[`/embed/${token}`]}>
      <Routes>
        <Route path="/embed/:token" element={<CountdownWidget />} />
      </Routes>
    </MemoryRouter>,
  );
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearEventOgMeta();
});

describe('CountdownWidget (embed)', () => {
  it('renders the widget and injects OG tags for the embed URL', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: async () => ({
        success: true,
        data: { name: '东京旅行', type: 'travel', date: '2099-01-01' },
      }),
    } as Response);

    renderAt('embedtoken12');

    expect(await screen.findByTestId('countdown-widget')).toBeInTheDocument();
    expect(screen.getByText('东京旅行')).toBeInTheDocument();
    expect(screen.getByText('旅行')).toBeInTheDocument();

    await waitFor(() => {
      expect(
        document.head.querySelector('meta[property="og:title"]')?.getAttribute('content'),
      ).toBe('东京旅行 · TimeMark');
    });
    expect(
      document.head.querySelector('meta[property="og:url"]')?.getAttribute('content'),
    ).toContain('/embed/embedtoken12');
  });

  it('shows a generic error for an invalid embed token', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: async () => ({ success: false, error: 'Not found' }),
    } as Response);

    renderAt('bad');

    expect(await screen.findByTestId('embed-error')).toHaveTextContent('链接无效或已失效');
    expect(document.head.querySelector('meta[property="og:title"]')).toBeNull();
  });
});
