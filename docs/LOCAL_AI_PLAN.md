# timemark 本地 AI（模仿知屋）设计方案

> 2026-10-05 · 目标：把知屋已验证的「浏览器端本地推理」方案移植到 timemark，
> 单用户个人数据全程不出本机——模型跑在浏览器 WebGPU，索引存 IndexedDB，
> 权重随站点同源直发（构建零下载、运行时零第三方 CDN）。

## 知屋方案回顾（已验证的关键结论）

1. **对话模型 = WebLLM 0.2.85 + Qwen2.5-0.5B-Instruct-q4f16_1-MLC**（自研 WebGPU 内核，
   实测 40+ tok/s）。不用 ONNX 路径做对话：Qwen3-0.6B 的 q4/q4f16 ONNX 导出在 ORT
   wasm/WebGPU 两条 EP 上都建不了 session（float16 Cast 节点），q4+wasm 实测 0.16 tok/s。
2. **向量化 = transformers.js 4.2.0 + all-MiniLM-L6-v2 q8**（384 维，23MB）。
   transformers 必须钉 4.2.0（4.3 的 ORT 1.31-dev 有 f16 Cast 故障）。
3. **权重直接入库**：构建环境下载 HF 不可靠 → 权重文件随仓库提交、站点同源
   `/models/` 直发，浏览器拉到后 IndexedDB/Cache 永久缓存，之后完全离线。
4. **目录必须镜像 HF 布局**（`<id>/resolve/main/`）：web-llm 的 cleanModelUrl 对
   不含 `/resolve/` 的 URL 一律追加 `resolve/main/`。
5. **索引**：IndexedDB 逐条存 `{id, contentHash, vector, engine}`，重建时哈希未变
   即跳过——「登上去让它跑一阵子」就是跑这个增量构建。
6. **降级链**：向量检索失败 → 关键词 TF 匹配，永不白屏。

## timemark 落地设计

### 知识库（KB）= 用户自己的数据

timemark 是个人日历/提醒应用，知识库就是：**事件**（名称/日期/类型/自定义文案/
农历）、**文档**（标题/备注）、**联系人**（姓名/关系/称呼映射）。这些数据只有
本人能看，最适合「数据不出本机」的本地 AI——云端 LLM 反而不合适。

### 架构（全部前端，零后端改动）

```
frontend/src/lib/local-ai/
  models.ts       WebLLM 模型契约（文件清单+sha256，从知屋同款权重复制）
  device.ts       WebGPU 能力探测（adapter + shader-f16）
  engine.ts       WebLLM 引擎加载/流式对话（OpenAI 兼容 chat.completions）
  embeddings.ts   MiniLM 本地向量管道（q8，384 维）
  idb.ts          极简 IndexedDB KV（无 Dexie 依赖，~60 行）
  kb.ts           KB 文档构建（events+documents+contacts）→ 增量向量化 → 余弦检索
  rag.ts          检索增强：top-k 上下文 + 问题 → 本地模型；带来源引用；无模型降级关键词
frontend/src/pages/LocalAI.tsx   「本地 AI（实验）」页面：状态面板 + 索引构建 + 对话
```

### 与知屋的差异（刻意简化）

| 知屋 | timemark v1 | 理由 |
|------|-------------|------|
| R2 分发 + IDB fetch 拦截缓存 | 纯同源 `/models/` + WebLLM 自带 cacheBackend:'indexeddb' | timemark 单源部署，不需要多存储后端 |
| ORT wasm 同源复制 | ORT wasm 走 jsdelivr CDN | CSP `connect-src https:` 已放行；MiniLM q8 很小，首载一次 |
| Dexie | 极简 IndexedDB 包装 | 少一个依赖 |
| 权重从 HF 下载入库 | 直接从知屋仓库复制（同 sha256 校验） | 零下载 |

### CSP 变更

`script-src` 增加 `'wasm-unsafe-eval'`（ONNX/WebGPU 必需），新增 `worker-src 'self' blob:`
（onnxruntime-web 的 proxy worker）。vercel.json 与 security-headers.ts 两处同步。

### 降级与门槛

- 无 WebGPU/shader-f16 → 明确提示不支持（q4f16 权重），不提供慢速 wasm 对话回退
  （知屋实测 0.16 tok/s 不可用——那是 ONNX 路径的教训，WebLLM 本身没有 wasm 回退）。
- 向量索引未建/模型未载 → 检索自动降级关键词匹配；对话给出明确状态而非假装智能。
- KB 文档上限 600 条 / 单条 2000 字符（个人数据规模绰绰有余，防 IndexedDB 失控）。

### 构建期索引 vs 运行期索引

- **构建期**：静态语料（节假日/节气/模板/帮助文档）已有 `build-search-index.mjs`
  的 MiniSearch 索引，不变。
- **运行期**：用户数据（事件/文档/联系人）只能在登录后的浏览器里向量化——这就是
  「登上去让它跑一阵子」的增量索引：页面开着时点「构建索引」，逐条哈希比对跳过
  已有条目，进度实时可见；之后同一浏览器秒级完成。
