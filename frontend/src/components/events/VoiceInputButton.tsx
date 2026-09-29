import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  getSpeechRecognitionConstructor,
  isSpeechRecognitionSupported,
  parseVoiceTranscript,
  voiceParseContext,
  type SpeechRecognitionInstance,
  type VoiceDraft,
} from './voice-input';

/**
 * Browser-local voice input control for EventForm (checkbox 145).
 *
 * Visual language mirrors the neighbouring event-name field (ui Button, rounded-2xl,
 * h-12, lucide icons). Audio is captured by the browser's own Web Speech API and never
 * reaches TimeMark; the transcript is parsed locally by the deterministic rules parser
 * and handed back as an editable draft. The form is never auto-submitted.
 */

const UNSUPPORTED_HINT = '当前浏览器不支持语音输入，请直接输入';

interface VoiceInputButtonProps {
  /** Receives the parsed draft; the parent prefills the form and the user confirms. */
  onDraft: (draft: VoiceDraft) => void;
  disabled?: boolean;
}

export function VoiceInputButton({ onDraft, disabled = false }: VoiceInputButtonProps) {
  const supported = isSpeechRecognitionSupported();
  const [listening, setListening] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);

  useEffect(() => {
    return () => {
      const recognition = recognitionRef.current;
      if (!recognition) return;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.abort();
    };
  }, []);

  if (!supported) {
    // Graceful degradation: the API is absent, so typing must stay untouched.
    return (
      <div className="shrink-0 text-center" data-testid="voice-input-unsupported">
        <Button
          type="button"
          variant="secondary"
          size="icon"
          className="h-12 w-12 rounded-2xl"
          disabled
          aria-label="语音输入（当前浏览器不支持）"
          title={UNSUPPORTED_HINT}
        >
          <MicOff size={18} aria-hidden="true" />
        </Button>
        <p
          id="voice-unsupported-hint"
          role="status"
          className="mt-1 max-w-[6rem] text-[10px] leading-tight text-slate-400 dark:text-slate-500"
        >
          {UNSUPPORTED_HINT}
        </p>
      </div>
    );
  }

  const handleResult = (event: SpeechRecognitionEvent) => {
    let transcript = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      if (result.isFinal && result.length > 0) transcript += result[0].transcript;
    }
    const text = transcript.trim();
    if (!text) return;
    const draft = parseVoiceTranscript(text, voiceParseContext());
    if (!draft) {
      setMessage('没能识别出明确的日期，请换个说法或直接输入');
      return;
    }
    onDraft(draft);
    setMessage(`已识别「${text}」，请核对草稿后确认保存`);
  };

  const handleError = (event: SpeechRecognitionErrorEvent) => {
    setListening(false);
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      setMessage('麦克风权限被拒绝，请在浏览器允许后重试，或直接输入');
    } else if (event.error === 'no-speech') {
      setMessage('没有检测到语音，请重试或直接输入');
    } else if (event.error === 'audio-capture') {
      setMessage('未找到可用的麦克风，请直接输入');
    } else {
      setMessage('语音识别不可用，请直接输入');
    }
  };

  const startListening = () => {
    const Constructor = getSpeechRecognitionConstructor();
    if (!Constructor) return;
    setMessage(null);
    const recognition = new Constructor();
    recognition.lang = navigator.language || 'zh-CN';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = handleResult;
    recognition.onerror = handleError;
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    try {
      recognition.start();
      setListening(true);
    } catch {
      setMessage('无法启动语音识别，请直接输入');
    }
  };

  const stopListening = () => {
    recognitionRef.current?.stop();
  };

  const statusText = listening ? '聆听中…（再次点击停止）' : message ?? '';

  return (
    <div className="shrink-0 text-center">
      <Button
        type="button"
        variant={listening ? 'vision' : 'secondary'}
        size="icon"
        className="h-12 w-12 rounded-2xl"
        onClick={listening ? stopListening : startListening}
        disabled={disabled}
        aria-pressed={listening}
        aria-label={listening ? '停止语音输入' : '语音输入事件'}
        title={listening ? '正在聆听，点击停止' : '用语音输入事件（浏览器本地识别）'}
      >
        {listening ? (
          <Mic className="animate-pulse" size={18} aria-hidden="true" />
        ) : (
          <Mic size={18} aria-hidden="true" />
        )}
      </Button>
      <p
        role="status"
        aria-live="polite"
        className="mt-1 max-w-[7rem] text-[10px] leading-tight text-slate-500 dark:text-slate-400"
      >
        {statusText}
      </p>
    </div>
  );
}
