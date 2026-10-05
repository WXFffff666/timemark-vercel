/**
 * 本地 AI 模型契约（模仿知屋 webllm-models.ts；单一事实源）。
 *
 * 为什么用 WebLLM：ONNX/ORT 路径上 Qwen3-0.6B 的 q4/q4f16 导出保留了 float16
 * Cast 节点，ORT wasm/WebGPU 都建不了 session（知屋在三个 ORT 版本上真浏览器
 * 取证一致复现），q4+wasm 实测 0.16 tok/s 不可用。WebLLM 用自研 WebGPU 内核，
 * 完全绕开 ORT，同款权重实测 40+ tok/s。
 *
 * 权重同源直发：frontend/public/models/mlc-ai/<id>/（目录镜像 HF 的
 * resolve/main/ 布局——web-llm 的 cleanModelUrl 对不含 /resolve/ 的 URL 一律
 * 追加 resolve/main/），与知屋仓库逐字节同源（sha256 与 HF lfs.oid 一致）。
 */

export type WebLlmModelFile = {
  file: string;
  bytes: number;
  /** sha256（HF tree API 的 lfs.oid；小件无 lfs 条目则为空串） */
  sha256: string;
};

export type WebLlmModel = {
  id: string;
  engineModelId: string;
  files: WebLlmModelFile[];
  /** 权重件字节总和（进度分母） */
  weightsBytes: number;
};

const S = (file: string, bytes: number, sha256 = ''): WebLlmModelFile => ({ file, bytes, sha256 });

export const WEBLLM_MODELS: { primary: WebLlmModel } = {
  primary: {
    id: 'mlc-ai/Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
    engineModelId: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
    files: [
      S('mlc-chat-config.json', 2041),
      S('tokenizer_config.json', 7308),
      S('tokenizer.json', 7031645),
      S('vocab.json', 2776833),
      S('merges.txt', 1671839),
      S('tensor-cache.json', 102431),
      S('ndarray-cache.json', 102431),
      S('params_shard_0.bin', 68067328, '9f309954d310dc63adfaf3ef6aa987c681b8aa6d1b9686aa2525b454b0d058d5'),
      S('params_shard_1.bin', 33234176, '6d174758dd299d9ef4222b1ad4283be832ebd43853951da25b50501ab1b75ba7'),
      S('params_shard_2.bin', 33505280, '83e0b530bf5c44cbead1a6c220af81040a975f7c81fb708977a02e3ac8d7ffa7'),
      S('params_shard_3.bin', 33053696, '5ff16197c197d8783d398d0c35fa9641e606e6e2dc1d53b9f26a0c9c17a97921'),
      S('params_shard_4.bin', 33020928, 'a7a3d2b02aa9258154f250a714d1743672e423c5c7c8e5c5eefcb9bf337aa0fd'),
      S('params_shard_5.bin', 29211648, '19dfd7a3064b84082915575c0e5a57fc1cd7108828e1ce9fbbbaf9db4b63b9af'),
      S('params_shard_6.bin', 33297408, '192576d43956aa977ec60848b8a7fc8483b5fe38ca9669aa9a3ca2ba795a7a33'),
      S('params_shard_7.bin', 14605824, '1ee25c2a41dad6833e000b7e3ec13a5a1761c32ffbed0ad8a98a6ad313338dc0'),
      // WebLLM per-model WebGPU kernel 库（0.2.85 → modelVersion v0_2_84/base），
      // 随站点自托管——raw.githubusercontent 国内不可达，是运行时硬依赖。
      S('Qwen2-0.5B-Instruct-q4f16_1_cs1k-webgpu.wasm', 4850160),
    ],
    // 各分片磁盘字节总和（与知屋仓库同源实测；分片逐字节一致，sha256 与 HF lfs.oid 对齐）
    weightsBytes: 277996288,
  },
};

/** 向量模型（transformers.js，同源 /models/ 直发） */
export const LOCAL_EMBEDDING_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
export const LOCAL_EMBEDDING_DIMS = 384;

export function webllmWeightsBytes(model: WebLlmModel): number {
  return model.files
    .filter((f) => f.file.endsWith('.bin'))
    .reduce((n, f) => n + f.bytes, 0);
}

/** 模型目录同源基地址（末尾带斜杠，WebLLM 直接拼文件名） */
export function webLlmModelBaseUrl(m: WebLlmModel = WEBLLM_MODELS.primary): string {
  const origin = typeof location !== 'undefined' ? location.origin : '';
  return `${origin}/models/${m.id}/`;
}

/**
 * 文件级基地址（HF 布局 resolve/main/）。web-llm 的 cleanModelUrl 对不含
 * /resolve/ 的 URL 一律追加 "resolve/main/"，就绪探测与 model_lib 都指向这一层。
 */
export function webLlmModelFilesBaseUrl(m: WebLlmModel = WEBLLM_MODELS.primary): string {
  return `${webLlmModelBaseUrl(m)}resolve/main/`;
}

/** 浏览器向量模型同源基地址（transformers.js env.localModelPath，末尾带斜杠） */
export function embeddingModelBaseUrl(): string {
  const origin = typeof location !== 'undefined' ? location.origin : '';
  return `${origin}/models/`;
}
