/**
 * WebLLM 本地对话引擎（从知屋 webllm-chat.ts 移植，去掉预热事件总线）。
 * 权重同源 /models/mlc-ai/<id>/（resolve/main 布局），WebGPU 推理，
 * cacheBackend:'indexeddb' 让权重首次下载后永久缓存。
 */
import {
  WEBLLM_MODELS,
  webLlmModelBaseUrl,
  webLlmModelFilesBaseUrl,
  webllmWeightsBytes,
} from './models';
import { probeDeviceCapability, isLocalChatCapable } from './device';

export type AiStatusCallback = (msg: string, progress?: number) => void;

export type WebLlmChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type WebLlmChatOptions = {
  maxTokens?: number;
  temperature?: number;
  onStatus?: AiStatusCallback;
  onToken?: (partial: string) => void;
  signal?: AbortSignal;
};

/** 引擎句柄（web-llm 类型保持 unknown，不把包类型泄漏进公共契约） */
type Engine = {
  chat: {
    completions: {
      create: (req: Record<string, unknown>) => Promise<AsyncIterable<{
        choices?: { delta?: { content?: string } }[];
      }>>;
    };
  };
  interruptGenerate: () => void;
  unload: () => Promise<void>;
};

const model = WEBLLM_MODELS.primary;

let enginePromise: Promise<Engine> | null = null;

export function resetWebLlmEngine(): void {
  const p = enginePromise;
  enginePromise = null;
  void p
    ?.then((e) => e.unload())
    .catch((err: unknown) => console.warn('[local-ai] 旧引擎卸载失败（忽略）:', err));
}

export async function isWebLlmSupported(): Promise<boolean> {
  try {
    return isLocalChatCapable(await probeDeviceCapability());
  } catch {
    return false;
  }
}

/** 同源权重可达性（有界 HEAD，探测主分片） */
export async function isWebLlmWeightReachable(timeoutMs = 8000): Promise<boolean> {
  const first = model.files.find((f) => f.file.endsWith('.bin'));
  if (!first) return false;
  try {
    const res = await fetch(`${webLlmModelFilesBaseUrl()}${first.file}`, {
      method: 'HEAD',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function getEngine(onStatus?: AiStatusCallback): Promise<Engine> {
  if (!enginePromise) {
    enginePromise = (async () => {
      const totalMB = Math.round(webllmWeightsBytes(model) / 1048576);
      onStatus?.(`准备本机模型（${totalMB} MB，WebGPU 推理；首次后 IndexedDB 缓存）…`, 0);
      const { CreateMLCEngine } = await import('@mlc-ai/web-llm');
      const engine = await CreateMLCEngine(model.engineModelId, {
        appConfig: {
          model_list: [
            {
              model: webLlmModelBaseUrl(),
              model_id: model.engineModelId,
              model_lib: `${webLlmModelFilesBaseUrl()}Qwen2-0.5B-Instruct-q4f16_1_cs1k-webgpu.wasm`,
            },
          ],
          // 0.2.85 起字段从 useIndexedDBCache 更名为 cacheBackend
          cacheBackend: 'indexeddb',
        },
        // 进度节流：每片每几毫秒回调一次，≥2% 或文本变化且距上次 ≥200ms 才上报
        initProgressCallback: (() => {
          let lastPct = -1;
          let lastAt = 0;
          let lastText = '';
          return (p: { progress?: number; text?: string }) => {
            const pct = Math.round((p.progress ?? 0) * 100);
            const text = p.text || '本机模型载入中…';
            const now = Date.now();
            const significant = pct - lastPct >= 2 || text !== lastText;
            if (!significant || now - lastAt < 200) return;
            lastPct = pct;
            lastText = text;
            lastAt = now;
            onStatus?.(text, p.progress);
          };
        })(),
      });
      onStatus?.('本机模型就绪', 1);
      return engine as unknown as Engine;
    })().catch((e: unknown) => {
      enginePromise = null;
      throw e;
    });
  }
  return enginePromise;
}

/** WebLLM 对话：OpenAI 兼容流式接口，onToken 回传累计文本 */
export async function chatWebLlm(
  messages: WebLlmChatMessage[],
  opts: WebLlmChatOptions = {},
): Promise<string> {
  const engine = await getEngine(opts.onStatus);
  if (opts.signal?.aborted) throw new Error('本机模型生成已停止');

  let acc = '';
  const onCallerAbort = (): void => engine.interruptGenerate();
  opts.signal?.addEventListener('abort', onCallerAbort, { once: true });

  try {
    const stream = await engine.chat.completions.create({
      messages,
      stream: true,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxTokens ?? 640,
    });
    for await (const chunk of stream) {
      if (opts.signal?.aborted) break;
      const delta = chunk.choices?.[0]?.delta?.content ?? '';
      if (delta) {
        acc += delta;
        opts.onToken?.(acc);
      }
    }
  } finally {
    opts.signal?.removeEventListener('abort', onCallerAbort);
  }
  return acc.trim();
}
