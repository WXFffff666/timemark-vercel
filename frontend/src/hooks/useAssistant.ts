import { useCallback, useRef, useState } from 'react';
import {
  confirmAgentAction,
  fetchAgentTools,
  invokeAgentAction,
  type AgentToolPreview,
  type AgentToolView,
} from '@/lib/api';
import { resolveAssistantIntent, type AssistantIntent } from '@/lib/assistant-intent';

/**
 * checkbox 109: the assistant state machine.
 *
 * The invariant this hook exists to hold: `submit()` ONLY ever calls `POST /api/agent/actions/:tool`
 * - it never issues the confirm call. The confirm request is sent solely by `confirm()`, which is
 * reachable only from the user clicking 确认. A destructive tool therefore cannot run until the
 * user explicitly confirms, and the confirm request is not even sent before that click.
 */

export type AssistantTranscriptStatus = 'pending' | 'executed' | 'confirm_required' | 'failed';

export interface AssistantTranscript {
  tool: string;
  args: unknown;
  status: AssistantTranscriptStatus;
  result?: unknown;
  error?: string;
}

export type AssistantConfirmationState = 'pending' | 'busy' | 'done' | 'cancelled' | 'failed';

export interface AssistantConfirmation {
  confirmationId: string;
  preview: AgentToolPreview;
  state: AssistantConfirmationState;
  error?: string;
}

export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  transcript?: AssistantTranscript;
  confirmation?: AssistantConfirmation;
}

/** Human, distinct messages for each confirm failure - never a collapsed generic error. */
export function confirmFailureMessage(code: string): string {
  switch (code) {
    case 'confirmation_already_used':
      return '该确认已被使用（可能已在别处确认过），操作不会重复执行。';
    case 'confirmation_expired':
      return '确认已过期，请重新发起该操作。';
    case 'confirmation_not_found':
      return '找不到该确认，可能已被清理或过期。';
    case 'invalid_confirmation_id':
      return '确认标识无效，请重新发起。';
    case 'forbidden':
      return '没有权限执行该操作。';
    default:
      return '确认失败，请稍后重试。';
  }
}

function defaultTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  } catch {
    return 'Asia/Shanghai';
  }
}

export function useAssistant() {
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [tools, setTools] = useState<AgentToolView[]>([]);
  const idRef = useRef(0);
  const messagesRef = useRef<AssistantMessage[]>([]);
  messagesRef.current = messages;

  const nextId = useCallback(() => `m${++idRef.current}`, []);

  // v2.28：运行态 + 停止能力（工具调用是一次 HTTP 往返，AbortController 中止 fetch）
  const [runningTool, setRunningTool] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const patchMessage = useCallback((id: string, patch: Partial<AssistantMessage>) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }, []);

  /** Load the tool registry once for the manual fallback form. Never auto-invokes a tool. */
  const loadTools = useCallback(async () => {
    try {
      const res = await fetchAgentTools();
      setTools(Array.isArray(res?.tools) ? res.tools : []);
    } catch {
      setTools([]);
    }
  }, []);

  /** Append an assistant turn, call the action endpoint, and record the outcome verbatim. */
  const runTool = useCallback(
    async (tool: string, args: Record<string, unknown>, understood: string) => {
      const id = nextId();
      setMessages((prev) => [
        ...prev,
        { id, role: 'assistant', text: understood, transcript: { tool, args, status: 'pending' } },
      ]);
      const controller = new AbortController();
      abortRef.current = controller;
      setRunningTool(tool);
      try {
        const outcome = await invokeAgentAction(tool, args, controller.signal);
        if (outcome.kind === 'confirm_required') {
          patchMessage(id, {
            text: `工具 ${outcome.preview.tool} 需要你确认后才会执行。`,
            transcript: { tool, args, status: 'confirm_required' },
            confirmation: { confirmationId: outcome.confirmationId, preview: outcome.preview, state: 'pending' },
          });
        } else {
          patchMessage(id, {
            text: '已执行。',
            transcript: { tool, args, status: 'executed', result: outcome.data },
          });
        }
      } catch (error) {
        const aborted = controller.signal.aborted;
        patchMessage(id, aborted
          ? { text: '已停止。', transcript: { tool, args, status: 'failed', error: 'aborted' } }
          : {
              text: `执行失败：${error instanceof Error ? error.message : '执行失败'}`,
              transcript: { tool, args, status: 'failed', error: error instanceof Error ? error.message : String(error) },
            });
      } finally {
        setRunningTool(null);
        abortRef.current = null;
      }
    },
    [nextId, patchMessage],
  );

  /** Natural-language entry point. Resolves intent, then either clarifies or runs one tool. */
  const submit = useCallback(
    async (rawText: string) => {
      const text = typeof rawText === 'string' ? rawText.trim() : '';
      if (!text) return;
      setMessages((prev) => [...prev, { id: nextId(), role: 'user', text }]);

      const intent: AssistantIntent = resolveAssistantIntent(text, {
        now: new Date(),
        timezone: defaultTimeZone(),
      });
      if (intent.kind === 'clarify') {
        setMessages((prev) => [...prev, { id: nextId(), role: 'assistant', text: intent.question }]);
        return;
      }
      await runTool(intent.tool, intent.args, intent.understood);
    },
    [nextId, runTool],
  );

  /** Manual fallback: invoke an explicitly chosen tool with explicit JSON arguments. */
  const invokeManual = useCallback(
    async (tool: string, args: Record<string, unknown>) => {
      await runTool(tool, args, `调用工具 ${tool}`);
    },
    [runTool],
  );

  /** Phase 2 - the ONLY place the confirm request is ever sent. */
  const confirm = useCallback(
    async (messageId: string) => {
      const message = messagesRef.current.find((m) => m.id === messageId);
      const pending = message?.confirmation;
      if (!pending || pending.state === 'busy') return;

      patchMessage(messageId, { confirmation: { ...pending, state: 'busy' } });
      const outcome = await confirmAgentAction(pending.confirmationId);

      if (outcome.kind === 'executed') {
        const current = messagesRef.current.find((m) => m.id === messageId);
        patchMessage(messageId, {
          text: '已确认并执行。',
          confirmation: { ...pending, state: 'done' },
          transcript: current?.transcript
            ? { ...current.transcript, status: 'executed', result: outcome.data }
            : current?.transcript,
        });
        return;
      }

      const failure = confirmFailureMessage(outcome.code);
      patchMessage(messageId, {
        text: failure,
        confirmation: { ...pending, state: 'failed', error: failure },
      });
    },
    [patchMessage],
  );

  /** Dismiss a confirmation without ever sending the confirm request. */
  const cancel = useCallback(
    (messageId: string) => {
      const message = messagesRef.current.find((m) => m.id === messageId);
      const pending = message?.confirmation;
      if (!pending) return;
      patchMessage(messageId, { confirmation: { ...pending, state: 'cancelled' } });
    },
    [patchMessage],
  );

  return { messages, tools, submit, confirm, cancel, invokeManual, loadTools, runningTool, stop };
}

export type AssistantController = ReturnType<typeof useAssistant>;
