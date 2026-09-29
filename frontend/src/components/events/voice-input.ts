import {
  parseWithRegex,
  type CreateEventOperation,
  type NlParseContext,
} from '@timemark/shared/nl-fallback';

/**
 * Browser-local voice input (checkbox 145).
 *
 * The Web Speech API transcribes speech **in the browser**; TimeMark never sees or
 * uploads audio - this module issues no network request of its own. The transcript is
 * fed to the EXISTING deterministic parser (`shared/src/nl-fallback.ts`, task 99, the
 * same regex layer `backend/src/services/ai/parse.ts` degrades to), so the voice path
 * works with every AI variable empty. The parsed result is returned as an editable
 * draft; the caller only prefills the form and the user must confirm before saving.
 */

// ---------------------------------------------------------------------------
// Narrow local Web Speech API typing (no dependency, no `any`).
// `SpeechRecognitionEvent` / `SpeechRecognitionErrorEvent` already exist in lib.dom;
// only the recognition instance + constructor (which lib.dom does NOT declare) are added.
// ---------------------------------------------------------------------------

export interface SpeechRecognitionInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  /** Required: opens the browser's own microphone capture. No audio leaves TimeMark. */
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

export interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionInstance;
}

interface SpeechWindowLike {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

/** The recognition constructor if the browser exposes it, else null. Never throws. */
export function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const speechWindow = window as unknown as SpeechWindowLike;
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

/** True when this browser can transcribe speech locally; drives the disabled fallback. */
export function isSpeechRecognitionSupported(): boolean {
  return getSpeechRecognitionConstructor() !== null;
}

// ---------------------------------------------------------------------------
// Rules-first parsing (deterministic, no AI, no network)
// ---------------------------------------------------------------------------

/** The editable draft a transcript resolves to; the caller prefills the form with it. */
export interface VoiceDraft {
  name: string;
  /** Plain `YYYY-MM-DD` from the deterministic parser - never a UTC ISO slice. */
  date: string | null;
  recurrence: { frequency: 'daily' | 'weekly' | 'monthly' | 'yearly'; interval: number } | null;
}

/** Build the parser context from the wall clock and the browser's IANA timezone. */
export function voiceParseContext(now: Date = new Date()): NlParseContext {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  return { now, timezone };
}

function toDraft(op: CreateEventOperation): VoiceDraft {
  return {
    name: op.title,
    date: op.date,
    recurrence: op.recurrence
      ? { frequency: op.recurrence.frequency, interval: op.recurrence.interval }
      : null,
  };
}

/**
 * Deterministic transcript -> draft. Returns null when the utterance needs a richer
 * parser (lunar, recurrence-with-lead-days, non-event intents) - the caller then asks
 * the user to type instead of guessing. Never throws, never calls the network.
 */
export function parseVoiceTranscript(text: string, ctx: NlParseContext): VoiceDraft | null {
  const op = parseWithRegex(text, ctx);
  if (!op || op.kind !== 'create_event') return null;
  return toDraft(op);
}
