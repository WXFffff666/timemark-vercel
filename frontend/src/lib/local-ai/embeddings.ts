/**
 * 本机向量管道：transformers.js + all-MiniLM-L6-v2（q8，384 维，同源 /models/ 直发）。
 * 必须钉 @huggingface/transformers 4.2.0 —— 4.3 拉起的 ORT 1.31-dev 有 f16 Cast
 * 故障（知屋真浏览器取证），勿升级。
 */
import { LOCAL_EMBEDDING_MODEL_ID, embeddingModelBaseUrl } from './models';

export type AiStatusCallback = (msg: string, progress?: number) => void;

type ExtractorFn = (
  text: string | string[],
  opts: Record<string, unknown>,
) => Promise<{ data: Float32Array; dims: number[] }>;

let extractorPromise: Promise<ExtractorFn> | null = null;

export function resetLocalEmbeddingPipeline(): void {
  extractorPromise = null;
}

async function configureEnv(): Promise<void> {
  const { env } = await import('@huggingface/transformers');
  // 权重同源：/models/<model_id>/ 直发；关掉远程兜底避免静默把请求打到 HF。
  env.allowLocalModels = true;
  env.localModelPath = embeddingModelBaseUrl();
  env.allowRemoteModels = false;
}

async function getExtractor(onStatus?: AiStatusCallback): Promise<ExtractorFn> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      onStatus?.('加载本机向量模型（23MB，首次后 IndexedDB 缓存）…', 0);
      await configureEnv();
      const { pipeline } = await import('@huggingface/transformers');
      const pipe = (await pipeline('feature-extraction', LOCAL_EMBEDDING_MODEL_ID, {
        dtype: 'q8',
      })) as unknown as ExtractorFn;
      onStatus?.('向量模型就绪', 1);
      return pipe;
    })().catch((e: unknown) => {
      extractorPromise = null;
      throw e;
    });
  }
  return extractorPromise;
}

/** 单条文本 → 384 维归一化向量（截断 2000 字符，与知屋同口径） */
export async function embedTextLocal(text: string, onStatus?: AiStatusCallback): Promise<number[]> {
  const extractor = await getExtractor(onStatus);
  const output = await extractor(text.slice(0, 2000), { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

/** 数值向量余弦相似度；空/零向量/长度不一致返回 0 */
export function vectorCosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const den = Math.sqrt(na) * Math.sqrt(nb);
  return den ? dot / den : 0;
}

/** 向量检索最低相似度阈值（低于视为无关） */
export const EMBEDDING_MIN_SCORE = 0.05;

/** 截断到 maxChars（连续空白压缩为单空格） */
export function sliceForEmbedding(text: string, maxChars = 2000): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= maxChars ? t : t.slice(0, maxChars);
}
