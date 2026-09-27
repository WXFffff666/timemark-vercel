import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { clearEventOgMeta } from '@/lib/og-meta';
import ShareEvent from './ShareEvent';

function renderAt(token: string) {
  return render(
    <MemoryRouter initialEntries={[`/share/${token}`]}>
      <Routes>
        <Route path="/share/:token" element={<ShareEvent />} />
      </Routes>
    </MemoryRouter>,
  );
}

function mockFetch(payload: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    json: async () => payload,
  } as Response);
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearEventOgMeta();
});

describe('ShareEvent page', () => {
  it('renders the event and injects OG tags WITH the event name', async () => {
    globalThis.fetch = mockFetch({
      success: true,
      data: {
        name: '妈妈的生日',
        type: 'birthday',
        date: '2099-08-15',
        calendar_type: 'gregorian',
        person_name: '妈妈',
      },
    });

    renderAt('tok12345678');

    expect(await screen.findByText('妈妈的生日')).toBeInTheDocument();
    expect(screen.getByTestId('share-event-card')).toBeInTheDocument();
    expect(screen.getByText('生日')).toBeInTheDocument();
    expect(screen.getByText('相关人：妈妈')).toBeInTheDocument();

    await waitFor(() => {
      expect(
        document.head.querySelector('meta[property="og:title"]')?.getAttribute('content'),
      ).toBe('妈妈的生日 · TimeMark');
    });
    expect(
      document.head.querySelector('meta[property="og:image"]')?.getAttribute('content'),
    ).toContain('/api/og/image/tok12345678');
    expect(
      document.head.querySelector('meta[name="twitter:card"]')?.getAttribute('content'),
    ).toBe('summary_large_image');
    expect(screen.getByTestId('share-countdown')).toHaveTextContent('还有');
  });

  it('shows an error state and injects NO OG data for an invalid token', async () => {
    globalThis.fetch = mockFetch({ success: false, error: 'Not found' });

    renderAt('bad');

    expect(await screen.findByTestId('share-event-error')).toHaveTextContent('Not found');
    expect(document.head.querySelector('meta[property="og:title"]')).toBeNull();
    expect(document.head.querySelector('meta[name="twitter:card"]')).toBeNull();
  });

  it('shows an error state when the network fails', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'));

    renderAt('bad');

    expect(await screen.findByText('加载失败')).toBeInTheDocument();
  });
});
