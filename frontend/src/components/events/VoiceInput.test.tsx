import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import type { CreateEventRequest } from '@timemark/shared';

/**
 * Checkbox 145 - browser-local voice input.
 *
 * Proves: (1) the deterministic rules parser turns a spoken phrase into a draft;
 * (2) EventForm prefills that draft and NEVER auto-submits (the user confirms);
 * (3) with the Web Speech API absent the control is disabled with an explanation and
 *     typing still works; (4) the speech path issues NO network request and never
 *     captures raw audio itself (audio is never uploaded); (5) permission denial shows
 *     a clear message and leaves the form usable for typing.
 */

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn().mockResolvedValue([]) },
  fetchAvailableChannels: vi.fn().mockResolvedValue([]),
}));

// Radix UI (@radix-ui/react-use-size) needs ResizeObserver, which jsdom does not provide.
class ResizeObserverStub {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

import { EventForm } from './EventForm';
import { VoiceInputButton } from './VoiceInputButton';
import { parseVoiceTranscript } from './voice-input';

// ---------------------------------------------------------------------------
// Stubbed Web Speech API
// ---------------------------------------------------------------------------

class FakeSpeechRecognition {
  static last: FakeSpeechRecognition | null = null;
  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  onresult: ((event: SpeechRecognitionEvent) => void) | null = null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null = null;
  onend: (() => void) | null = null;
  start() {
    FakeSpeechRecognition.last = this;
  }
  stop() {
    this.onend?.();
  }
  abort() {}
}

function installSpeechRecognition() {
  FakeSpeechRecognition.last = null;
  const holder = window as unknown as {
    SpeechRecognition?: new () => FakeSpeechRecognition;
    webkitSpeechRecognition?: new () => FakeSpeechRecognition;
  };
  holder.SpeechRecognition = FakeSpeechRecognition;
  holder.webkitSpeechRecognition = FakeSpeechRecognition;
}

function removeSpeechRecognition() {
  FakeSpeechRecognition.last = null;
  const holder = window as unknown as {
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
  };
  delete holder.SpeechRecognition;
  delete holder.webkitSpeechRecognition;
}

function finalResultEvent(transcript: string): SpeechRecognitionEvent {
  const alternative = { transcript, confidence: 1 };
  const result = { isFinal: true, length: 1, 0: alternative };
  return { resultIndex: 0, results: { length: 1, 0: result } } as unknown as SpeechRecognitionEvent;
}

function errorEvent(error: string): SpeechRecognitionErrorEvent {
  return { error, message: error } as unknown as SpeechRecognitionErrorEvent;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  removeSpeechRecognition();
});

// ---------------------------------------------------------------------------
// 1. Deterministic rules-first parser
// ---------------------------------------------------------------------------

describe('parseVoiceTranscript (rules-first, no AI, no network)', () => {
  it('parses an absolute spoken date into an editable draft', () => {
    const ctx = { now: new Date(2026, 9, 5, 12), timezone: 'Asia/Shanghai' };
    expect(parseVoiceTranscript('交报告 2026-10-05', ctx)).toEqual({
      name: '交报告',
      date: '2026-10-05',
      recurrence: null,
    });
  });

  it('resolves 明天 in the browser timezone, never by slicing a UTC ISO string', () => {
    // 2026-10-01T20:00Z is already 2026-10-02 04:00 in Asia/Shanghai.
    const ctx = { now: new Date('2026-10-01T20:00:00.000Z'), timezone: 'Asia/Shanghai' };
    // A naive toISOString().slice(0,10) gives the UTC day 2026-10-01 -> 明天 2026-10-02 (wrong).
    // The local day is 2026-10-02, so 明天 must be 2026-10-03.
    expect(parseVoiceTranscript('买牛奶 明天', ctx)?.date).toBe('2026-10-03');
  });

  it('parses a recurrence', () => {
    const ctx = { now: new Date('2026-10-01T04:00:00.000Z'), timezone: 'Asia/Shanghai' };
    expect(parseVoiceTranscript('每周一 开例会', ctx)?.recurrence).toEqual({
      frequency: 'weekly',
      interval: 1,
    });
  });

  it('returns null for utterances the deterministic layer must not guess', () => {
    const ctx = { now: new Date(2026, 9, 5, 12), timezone: 'Asia/Shanghai' };
    expect(parseVoiceTranscript('下个月提醒我续费会员', ctx)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2 + 3. EventForm integration: prefilled draft, confirm required, API absent
// ---------------------------------------------------------------------------

describe('EventForm voice input', () => {
  beforeEach(() => {
    navigateMock.mockClear();
  });

  function renderForm(onSubmit: (data: CreateEventRequest) => Promise<void>) {
    return render(
      <BrowserRouter>
        <EventForm open onClose={vi.fn()} onSubmit={onSubmit} />
      </BrowserRouter>,
    );
  }

  it('prefills a draft from a stubbed recognition result and requires confirmation', async () => {
    installSpeechRecognition();
    const onSubmit = vi.fn<(data: CreateEventRequest) => Promise<void>>().mockResolvedValue(undefined);

    renderForm(onSubmit);

    await userEvent.click(screen.getByRole('button', { name: '语音输入事件' }));
    expect(FakeSpeechRecognition.last).not.toBeNull();

    await act(async () => {
      FakeSpeechRecognition.last?.onresult?.(finalResultEvent('交报告 2026-10-05'));
    });

    expect(screen.getByLabelText('事件名称')).toHaveValue('交报告');
    expect(screen.getByLabelText('事件日期')).toHaveValue('2026-10-05');
    // The draft is visible and the user is told to review before saving.
    expect(screen.getByText(/请核对后再点击/)).toBeInTheDocument();
    // NEVER auto-submitted.
    expect(onSubmit).not.toHaveBeenCalled();

    // Only an explicit confirm submits.
    await userEvent.click(screen.getByRole('button', { name: '确认保存' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ name: '交报告', date: '2026-10-05' });
  });

  it('disables the control with an explanation when the API is absent, and typing still works', async () => {
    removeSpeechRecognition();
    const onSubmit = vi.fn<(data: CreateEventRequest) => Promise<void>>().mockResolvedValue(undefined);

    renderForm(onSubmit);

    const button = screen.getByRole('button', { name: '语音输入（当前浏览器不支持）' });
    expect(button).toBeDisabled();
    expect(screen.getByText('当前浏览器不支持语音输入，请直接输入')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('事件名称'), '手动输入事件');
    expect(screen.getByLabelText('事件名称')).toHaveValue('手动输入事件');
  });

  it('shows a clear message on permission denial and leaves the form usable for typing', async () => {
    installSpeechRecognition();
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const onSubmit = vi.fn<(data: CreateEventRequest) => Promise<void>>().mockResolvedValue(undefined);

    renderForm(onSubmit);

    await userEvent.click(screen.getByRole('button', { name: '语音输入事件' }));
    await act(async () => {
      FakeSpeechRecognition.last?.onerror?.(errorEvent('not-allowed'));
    });

    expect(screen.getByText(/麦克风权限被拒绝/)).toBeInTheDocument();

    // The form is still fully usable for typing.
    await userEvent.type(screen.getByLabelText('事件名称'), '仍然可以输入');
    expect(screen.getByLabelText('事件名称')).toHaveValue('仍然可以输入');
    expect(screen.getByLabelText('事件日期')).toBeEnabled();
    expect(screen.getByRole('button', { name: '确认保存' })).toBeEnabled();
    expect(alertSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. Audio is never sent, and the speech path issues no network request at all
// ---------------------------------------------------------------------------

describe('VoiceInputButton never sends audio or issues a network request', () => {
  it('parses a transcript entirely locally with zero fetch/XHR/getUserMedia calls', async () => {
    installSpeechRecognition();
    const fetchMock = vi.fn(() => Promise.reject(new Error('network call attempted')));
    vi.stubGlobal('fetch', fetchMock);
    const xhrOpen = vi.spyOn(XMLHttpRequest.prototype, 'open');
    const getUserMedia = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    const onDraft = vi.fn();

    render(<VoiceInputButton onDraft={onDraft} />);

    await userEvent.click(screen.getByRole('button', { name: '语音输入事件' }));
    await act(async () => {
      FakeSpeechRecognition.last?.onresult?.(finalResultEvent('交报告 2026-10-05'));
    });

    expect(onDraft).toHaveBeenCalledTimes(1);
    const payload = onDraft.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['date', 'name', 'recurrence']);
    expect(JSON.stringify(payload)).not.toMatch(/audio|blob|base64|data:/i);

    // No network request of any kind, so no request body could ever contain audio.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(xhrOpen).not.toHaveBeenCalled();
    // TimeMark never captures raw audio itself.
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});
