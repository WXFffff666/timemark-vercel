/**
 * WebLLM 本地对话引擎（多档模型版，知屋 webllm-chat.ts 的 Map 模式）。
 *
 * 档位见 models.ts：phone（内置秒开）/ chinese / uncensored（在线获取，
 * WebLLM 流式下载到 IndexedDB 永久缓存后离线可用）。
 * 同一时刻只保留一个引擎：切换档位先卸载旧引擎释放显存/内存。
 */
import {
  WEBLLM_MODELS,
  formatWeightsMB,
  modelWeightsBaseUrl,
  sameOriginKernelUrl,
  type WebLlmModel,
  type WebLlmTierId,
} from './models';
import { probeDeviceCapability, isLocalChatCapable } from './device';

export type AiStatusCallback = (msg: string, progress?: number) => void;

export type WebLlmChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type WebLlmChatOptions = {
  tier?: WebLlmTierId;
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

export function resolveTier(tier?: WebLlmTierId | null): WebLlmModel {
  if (tier && tier in WEBLLM_MODELS) return WEBLLM_MODELS[tier];
  return WEBLLM_MODELS.phone;
}

const engines = new Map<WebLlmTierId, Promise<Engine>>();
/** 当前激活档（unload 旧引擎时用） */
let activeTier: WebLlmTierId | null = null;

export function getActiveTier(): WebLlmTierId | null {
  return activeTier;
}

/** 卸载指定（或全部）引擎，释放 WebGPU/内存 */
export async function unloadEngines(tier?: WebLlmTierId): Promise<void> {
  const targets = tier ? [tier] : [...engines.keys()];
  for (const t of targets) {
    const p = engines.get(t);
    engines.delete(t);
    if (activeTier === t) activeTier = null;
    void p
      ?.then((e) => e.unload())
      .catch((err: unknown) => console.warn(`[local-ai] ${t} 引擎卸载失败（忽略）:`, err));
  }
}

export async function isWebLlmSupported(): Promise<boolean> {
  try {
    return isLocalChatCapable(await probeDeviceCapability());
  } catch {
    return false;
  }
}

/**
 * bundled 档主权重可达性（有界 HEAD）。
 * remote 档恒返回 true——权重按需从镜像下载，探测远端可达性意义有限且会被限流。
 */
export async function isTierWeightReady(model: WebLlmModel, timeoutMs = 8000): Promise<boolean> {
  if (model.source !== 'bundled') return true;
  const first = model.files.find((f) => f.file.endsWith('.bin'));
  if (!first) return false;
  try {
    const res = await fetch(`${modelWeightsBaseUrl(model)}${first.file}`, {
      method: 'HEAD',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function buildEngine(model: WebLlmModel, onStatus?: AiStatusCallback): Promise<Engine> {
  const totalMB = formatWeightsMB(model.weightsBytes);
  onStatus?.(
    model.source === 'bundled'
      ? `准备本机模型（${totalMB}，WebGPU 推理）…`
      : `准备本机模型（${totalMB}，首次将下载到浏览器永久缓存）…`,
    0,
  );
  const { CreateMLCEngine } = await import('@mlc-ai/web-llm');
  const engine = await CreateMLCEngine(model.engineModelId, {
    appConfig: {
      model_list: [
        {
          model: modelWeightsBaseUrl(model),
          model_id: model.engineModelId,
          model_lib: sameOriginKernelUrl(model),
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
}

async function getEngine(tier: WebLlmTierId, onStatus?: AiStatusCallback, signal?: AbortSignal): Promise<Engine> {
  const existing = engines.get(tier);
  if (existing) return existing;
  const model = resolveTier(tier);
  const promise = (async () => {
    // 单引擎策略：切档先卸载旧引擎，释放显存
    if (activeTier && activeTier !== tier) await unloadEngines(activeTier);
    const engine = await buildEngine(model, onStatus);
    activeTier = tier;
    return engine;
  })().catch((e: unknown) => {
    engines.delete(tier);
    throw e;
  });
  engines.set(tier, promise);
  // v2.28：模型加载（首次需下载/编译权重，可达数十秒）期间点「停止」立即拒绝
  // 本次等待（底层加载无法取消——WebLLM 无取消入口——但不会阻塞用户）。
  if (signal?.aborted) {
    engines.delete(tier);
    throw new Error('本机模型加载已停止');
  }
  if (!signal) return promise;
  return Promise.race([
    promise,
    new Promise<Engine>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('本机模型加载已停止')), { once: true });
    }),
  ]);
}

/** WebLLM 对话：OpenAI 兼容流式接口，onToken 回传累计文本 */
export async function chatWebLlm(
  messages: WebLlmChatMessage[],
  opts: WebLlmChatOptions = {},
): Promise<string> {
  const tier = opts.tier ?? 'phone';
  const engine = await getEngine(tier, opts.onStatus, opts.signal);
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
