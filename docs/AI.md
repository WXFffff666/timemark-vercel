# AI 助手（本地模型 + 云端回退）

> TimeMark 的 AI 功能默认全部关闭。**不配置任何 `AI_*` / `OLLAMA_*` 变量时，应用完全可用**，
> 提醒、待办、集成等核心功能不受影响；缺失的 AI 能力只会「优雅降级」。

AI 网关使用 **OpenAI 兼容协议**（`POST {baseUrl}/chat/completions`），因此同一套代码既能接云端
免费模型，也能接你本机的模型。供应商 **只从环境变量解析**，接口层不接受请求方传入的 URL（防 SSRF）。

### 供应商解析顺序

网关按固定顺序解析「命名供应商」，先命中者胜出：

1. **primary（云端主用）** — `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL`
2. **fallback（云端备用）** — `AI_FALLBACK_BASE_URL` / `AI_FALLBACK_API_KEY` / `AI_FALLBACK_MODEL`
3. **local（本地模型）** — `OLLAMA_BASE_URL`（默认 `http://localhost:11434/v1`）/ `OLLAMA_MODEL`
   / `OLLAMA_API_KEY`（可选，Ollama 与 LM Studio 无需密钥）

选择这个顺序的原因：云端免费额度快且零运维，优先使用；本地模型作为「没有云端时的兜底」。
`local` 只有设置了 `OLLAMA_MODEL` 才会启用——`OLLAMA_BASE_URL` 的 `localhost` 默认值是**唯一允许的默认值**，
且仅供开发期使用（生产环境必须显式配置）。因此一份空的 `.env.example` 仍然让 AI 保持关闭。

`GET /api/ai/status` 会报告当前生效的供应商，并对**当前生效的供应商**做一次**短超时**可达性探测
（`GET {baseUrl}/models`，约 1.5s 上限）：可达 `reachable:true`，连不上 `reachable:false`（`unreachable`）。
该接口**永不**返回 API Key，也**永不**返回完整 Base URL（只返回主机名 host）。探测失败/超时都只是
「不可达」，绝不让 `/api/ai/status` 变慢或抛错。

### 本地模型推荐（四大家族）

| 模型家族 | 体积 / 内存 | 许可 | 工具调用（function calling） |
|---|---|---|---|
| **Phi-4-mini 3.8B** | ~3 GB Q4，CPU-friendly | MIT | function calling supported |
| **Qwen3 4B / Qwen3 8B** | Qwen3 4B：3-4 GB；Qwen3 8B：6-8 GB | Apache-2.0 | strongest out-of-the-box tool calling |
| **Gemma 4 E2B** | 8 GB CPU box 上约 7.6 tok/s | Gemma 许可 | native function calling |
| **FunctionGemma 270M** | 面向 very low-end hardware | Gemma 许可 | 专为函数调用微调 |

一句话速记：

- `Phi-4-mini 3.8B` — ~3 GB Q4, CPU-friendly, MIT, function calling supported.
- `Qwen3 4B` — ~3-4 GB；`Qwen3 8B` — ~6-8 GB, Apache-2.0, strongest out-of-the-box tool calling of the three.
- `Gemma 4 E2B` — ~7.6 tok/s on an 8 GB CPU box, native function calling.
- `FunctionGemma 270M` — for very low-end hardware.

参考吞吐（供选型参考，非承诺）：Qwen3 8B 在 RTX 3060 上约 40-50 tok/s；Phi-4-mini 纯 CPU 约 15-20 tok/s；
Gemma 4 E2B 在 8 GB Raspberry Pi 5 上约 7.6 tok/s。

### 三选一的取舍

- **最省心的工具调用**：Qwen3（4B 适合 8 GB 内存的机器，8B 适合 16 GB）。
- **纯 CPU / 低内存**：Phi-4-mini 3.8B（MIT，商用友好）。
- **极低端硬件 / 树莓派**：FunctionGemma 270M；要更像样的对话再考虑 Gemma 4 E2B。

### 如何运行本地模型

### Ollama（推荐）

```bash
# 1) 安装 Ollama 后拉取模型（任选）
ollama pull qwen3:8b
ollama pull phi4-mini
ollama pull gemma4:e2b

# 2) 确认服务在跑（OpenAI 兼容端点在 /v1）
#    默认地址即 localhost:11434/v1
curl http://localhost:11434/v1/models
```

Ollama 暴露 OpenAI 兼容 API，默认 `http://localhost:11434/v1`。把网关指向它：

```bash
OLLAMA_BASE_URL=http://localhost:11434/v1   # 默认值，仅供开发期
OLLAMA_MODEL=qwen3:8b                        # 必填，否则本地供应商处于关闭状态
```

### LM Studio

LM Studio 内置 OpenAI 兼容服务器（默认 `http://localhost:1234/v1`）：在 LM Studio 里加载模型并启动
「Local Server」，然后把 `OLLAMA_BASE_URL` 指到该地址、`OLLAMA_MODEL` 填模型标识即可。

### 在 TimeMark 中测试

设置页 →「AI 助手（本地 / 云端）」区块：选择供应商（primary / fallback / local）、查看或预填模型名与
Base URL，点击 **测试连接** —— 它只会发送一条极短的 `ping` 提示，返回成功/延迟，或一个类型化的错误码。

### 免费云端替代方案与注意事项

| 供应商 | 免费额度 | 重要注意 |
|---|---|---|
| Google Gemini | 免费层可用 | **免费层的输入会被用于 improve Google products** —— 启用前请务必知悉 |
| OpenRouter | 免费模型受限于 **50 req/day** | 超出即失败，需自带节流 |
| Groq | 免费层额度高、速度快 | 契约上 **no-training**（不使用输入训练）默认成立 |
| Cerebras / Mistral / Cloudflare Workers AI | 各自的免费额度 | 速率/令牌上限不同，按需选择 |

> Gemini 免费层「用于改进 Google 产品」这一条是**必须披露**的前提；若对隐私敏感，请改用 Groq、
> 自备 key 的付费层，或本地模型。

### 部署在 Vercel 时的关键限制

**当 TimeMark 部署在 Vercel 上时，它位于云端，cannot reach 用户本机的 `localhost`。**
也就是说：在你家里 NAS / PC 上跑的 Ollama 或 LM Studio，Vercel 上的 TimeMark 是连不上的。

因此本地模型的正确用法是**反向连接**：

- **in-app 助手**（页面里的对话）需要的是**可达的端点**——要么是公网可达的自托管 OpenAI 兼容服务，
  要么直接使用云端免费供应商（primary / fallback）。
- **MCP / tool API 路径**（任务 103）则相反：由**本机的本地 AI 主动连接 OUT 到 TimeMark** 的
  MCP / 工具 API。方向是「本机 → 云端」，所以 Vercel 无法回连本机这件事不影响这条链路。

简言之：本地模型服务的是 **MCP / tool API** 方向；页面内助手要么走可达端点，要么走云端。

### 环境变量速查

| 变量 | 默认 | 说明 |
|---|---|---|
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | 空 | 云端主用（OpenAI 兼容） |
| `AI_FALLBACK_BASE_URL` / `AI_FALLBACK_API_KEY` / `AI_FALLBACK_MODEL` | 空 | 云端备用回退 |
| `OLLAMA_BASE_URL` | `http://localhost:11434/v1` | 本地模型端点（唯一允许的默认值，**仅开发期**） |
| `OLLAMA_MODEL` | 空 | 本地模型名；**留空 = 本地供应商关闭** |
| `OLLAMA_API_KEY` | 空 | 可选（Ollama / LM Studio 不需要） |

除 `OLLAMA_BASE_URL` 的 `localhost` 开发默认值外，**所有 AI 变量在 `.env.example` 中均为空**；
一个变量都不配置时应用照常运行。密钥只从环境变量读取，永不写入日志，也不会出现在
`/api/ai/status` 或错误信息中。

## v2.26 专项调研：能否用 Vercel 服务器的 GPU 跑生成式 AI？

> 结论先给：**不能，也不需要**。以下三条均已在 2026-10 联网核实。

1. **运行时不占构建时间（核实无误）**。Vercel Functions 是运行时资源，按 Fluid
   compute 的活跃 CPU 计费，与构建分钟完全分离。
2. **GPU 不可用（Hobby 计划）**。Vercel 自 2026-07 起 beta 提供 serverless GPU /
   agentic 长时计算基础设施，但相关能力（含 30 分钟函数）普遍要求 Pro 计划，
   没有任何证据表明对 Hobby 开放。
3. **CPU 推理不可用（生成场景）**。函数内存上限 3009MB、共享低核 CPU。0.5B q4
   模型理论上塞得进内存，但冷启动加载 + 共享 CPU 实测每秒只有几个 token，只够
   embeddings/分类，写祝福这类生成式输出体验不可接受。

**实际分工**：生成类任务（祝福正文、周报综述、月度叙述）走外接 OpenAI 兼容 API
（`AI_*` 网关，baseUrl 可指向 Vercel AI Gateway / 硅基流动 / DeepSeek 等任意便宜
端点）；隐私问答与祝福草稿走浏览器本地 WebGPU 推理（LocalAI 页，数据不出本机）。
各 AI 消费者与预算见下表。

| 消费者 | 入口 | 预算 |
| --- | --- | --- |
| 生日祝福正文 | `composeGreetingContentWithAi` | 日上限 20 条（超限回落组合引擎）；每 tick 上限 5 条 |
| 周报 AI 综述 | `aiNarrateWeeklyReview` | 每 user 每周至多 1 次、maxTokens 220，失败/未配置退回确定性渲染 |
| 月度摘要叙述 | digest.service | 与周报同回落链路，正文归档进 `digest_archive` |
