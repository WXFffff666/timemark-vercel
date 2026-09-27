# 附件存储威胁模型（ATTACHMENTS.md）

> 适用代码：`backend/src/services/storage.service.ts`、`attachment.service.ts`、
> `attachment-retention.service.ts`、`backend/src/routes/attachments.ts`、
> `backend/src/utils/attachment-signing.ts`。
> 迁移：v37 `attachments`；领域表 v38 `documents`。
> 本文件是 checkbox 52/53/57 的威胁模型与运维契约。

## 1. 数据模型

| 项目 | 说明 |
|---|---|
| 元数据 | `attachments(id, user_id, owner_type, owner_id, filename, content_type, byte_size, sha256, storage_key, created_at)` |
| 字节 | **只存对象存储**（Vercel Blob；开发模式回退本地 `.data/attachments`）。Postgres 永远不存字节（Neon 免费档 0.5 GB/项目）。 |
| 归属 | `(owner_type, owner_id)` 多态指向 `documents / expiry_items / inventory_items / maintenance_plans / events` 中**当前用户拥有**的行；两列要么同时为空（未关联），要么同时有值（DB CHECK `attachments_owner_pair`）。 |
| storage_key | 服务端生成：`attachments/<userId>/<uuid>.<ext>`。用户文件名**不参与** key 生成（仅作展示标签）。 |

## 2. 谁能读（访问控制）

1. **列表**：`GET /api/attachments` 必须经过会话认证（`authMiddleware`）；只返回 `user_id = 自己` 的行。**不存在**匿名/公开列表端点；对象存储本身默认 `private`（`BLOB_ACCESS=public` 可覆盖，但不推荐，且客户端仍拿不到提供方 URL）。
2. **下载（直连流式）**：`GET /api/attachments/:id` —— 每次请求都做 `id + user_id` 归属查询；他人的行与不存在的行**都返回 404**（不泄露存在性）。
3. **短时签名 URL**：`GET /api/attachments/:id/signed-url` —— **先做归属校验**，再签发：
   - 返回的是 **API 相对路径**（`/api/attachments/:id/download?expires=<epochMs>&signature=<hmac>`），**绝不是**对象存储的 URL；
   - 消费时（`GET /api/attachments/:id/download`）仍然要求会话，且**再次**执行归属查询 —— 「有效签名 + 他人会话 → 404」。签名只证明链接由本服务签发，**不构成**授权。
   - HMAC-SHA256，密钥优先级 `ATTACHMENT_URL_SECRET` > `JWT_SECRET` > `MASTER_KEY`；三者都缺失时 fail closed（503），绝不退化到无签名。
4. **签名有效期**：TTL 硬上限 **300 秒（5 分钟）**（`ATTACHMENT_SIGNED_URL_TTL_SECONDS`）。请求 `ttl` 参数会被收敛到 `[1, 300]`；过期签名返回 **403 已过期**，无效签名返回 **403 无效**。对象存储层的 `getSignedUrl()`（若未来直接使用）同样收敛到 ≤ 300 秒。
5. **签名/URL 不落日志**：路由从不记录 URL 或签名；`utils/logger.ts` 的 redact 列表额外包含 `signature` / `signedUrl` / `signed_url`，即使调用方误传也会在序列化前被 `[REDACTED]`。

## 3. 上传上限与类型白名单

| 规则 | 值 |
|---|---|
| 大小上限 | **2 MB**（`ATTACHMENT_MAX_BYTES`）；multipart 与 base64 信封都有 Content-Length 预检，**在触达对象存储之前**拒绝（413/400）。零字节拒绝。 |
| 白名单 | `application/pdf, image/png, image/jpeg, image/webp, text/plain` |
| 明确拒绝 | `image/svg+xml`（脚本向量）以及其他一切类型 |
| 声明 vs 实际 | **拒绝**（fail closed）：magic-byte 嗅探（`%PDF-`、PNG/JPEG/WebP 头、UTF-8 文本）与声明不符即 400；`.exe` 改名 `.pdf` 也会被识别为未知内容而拒绝。**不做静默改写。** |
| 下载响应头 | 始终 `Content-Disposition: attachment`（ASCII 净化回退 + RFC 5987 `filename*`，CR/LF 不可能存活）、`X-Content-Type-Options: nosniff`、`Cache-Control: private, no-store`；绝不内联渲染不可信 PDF/HTML。 |

## 4. 删除语义

1. `DELETE /api/attachments/:id`：**先删行（事实来源）**，再尽力删除对象；对象删除失败只记日志（不复活行），由保留策略下次重试。
2. 解链 `DELETE /api/documents/:id/attachments/:attachmentId`：只把 `(owner_type, owner_id)` 置空，**不删**行与对象（可重新关联）。
3. **孤儿清理（daily-maintenance，checkbox 57）**：`purgeOrphanAttachments()` 删除满足以下条件的附件：
   - 未关联（`owner_type IS NULL`）；或
   - owner 行已不存在（对应领域表中没有 `id = owner_id AND user_id = 自己` 的行）；
   - 且 `created_at < NOW() - 30 天`（截断时间由数据库 `NOW()` 每次执行时计算，无进程内缓存）。
   - 已关联且 owner 行仍在的附件**永不清理**；单批上限 500 行（下一轮继续）。
4. 父实体删除时的级联：
   - 删除 `documents/expiry_items/inventory_items/maintenance_plans` 行不会级联删除附件行（多态引用无 FK），这些附件因此成为孤儿，30 天后由保留策略清理；
   - 删除 `users` 行会级联删除 `attachments` 行（`ON DELETE CASCADE`），但**不会**删除对象字节 —— 运维侧需另行清理对象存储中的残留。

## 5. 备份与导出（重要）

- **数据导出（`GET /api/data/export`）只含附件 METADATA，不含字节。** 导出字段：`id, owner_type, owner_id, filename, content_type, byte_size, sha256, storage_key, created_at`。
  - `storage_key` 是内部对象引用（不是签名 URL、不是凭证），用于在对象仍在时恢复元数据行；
  - 恢复字节必须**另行备份对象存储**（Vercel Blob 快照/导出，或本地 `.data/attachments` 目录的常规备份）。
- 导入（`POST /api/data/import`）按导出中的 `storage_key` 恢复附件行；若对象已不在存储中，行仍可恢复但下载会 404「附件文件缺失」。
- 本地回退模式（无 `BLOB_READ_WRITE_TOKEN`，仅开发）把字节写到 `ATTACHMENT_LOCAL_DIR`（默认 `./.data/attachments`）。**Serverless 生产的临时磁盘不持久**，生产缺 token 时所有附件操作返回 503，绝不悄悄写磁盘。

## 6. 已知限制：无病毒扫描

没有适合 Serverless 且免费的病毒扫描器，因此**未接入 AV/沙箱扫描**，这是刻意的取舍。补偿控制：

- 严格白名单（无 SVG/HTML/可执行文件）+ magic-byte 嗅探（拒绝改名伪装）；
- 下载一律 `attachment` + `nosniff`，不内联渲染；
- 对象存储私有，读取必须经过带会话的 API（或短时签名 + 会话 + 归属复核）；
- 2 MB 上限缩小攻击面。

残余风险：把白名单内的恶意 PDF（如带漏洞的阅读器利用）上传并自行打开。用户应只打开自己信任来源的文件；如需更强保证，应在导出/下载链路之外接入外部 AV 服务（例如上传后异步扫描并在元数据上标记，本仓库未实现）。

## 7. 与前端 `frontend/src/pages/Documents.tsx` 的 UI 契约（该页面由另一 lane 并行开发）

- 上传：`POST /api/attachments`（multipart：`file` + `ownerType=document` + `ownerId`），或 JSON base64（字段 `ownerType/ownerId/filename/contentType/dataBase64`）。客户端同样强制 2 MB + 类型白名单（与服务端一致），但**服务端才是权威**（客户端校验只是为了少一次往返）。
- 列表：`GET /api/attachments?owner_type=document&owner_id=<id>` → `{ success, data: PublicAttachment[], pagination }`；`PublicAttachment` 含 `id/owner_type/owner_id/filename/content_type/byte_size/sha256/created_at/download_url`，**不含 `storage_key`**。
- 下载：既可直接 `GET /api/attachments/:id` 流式下载，也可先 `GET /api/attachments/:id/signed-url` 拿到 5 分钟有效的 API 链接再 `GET /api/attachments/:id/download?expires=&signature=`（必须带会话）。
- 删除：`DELETE /api/attachments/:id`；与证件解链用 `DELETE /api/documents/:id/attachments/:attachmentId`（保留文件）。
- 证件号码一直是掩码展示；附件与号码无关（号码是加密列，见 `document.service.ts`）。

## 8. 环境变量

| 变量 | 作用 |
|---|---|
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob 令牌；未设置且生产环境 → 附件操作 503 |
| `BLOB_ACCESS` | `private`（默认）/ `public`；公开 store 时由 Blob 侧决定对象可达性 |
| `ATTACHMENT_URL_SECRET` | 可选，签名 HMAC 专用密钥；缺省回退 `JWT_SECRET` / `MASTER_KEY` |
| `ATTACHMENT_LOCAL_DIR` | 本地回退目录（仅开发） |

## 9. 威胁模型速查

| 威胁 | 控制 |
|---|---|
| 未认证读取/列举 | 所有 `/api/attachments` 路由必须会话；无公开列表；对象存储私有 |
| 越权读取他人附件 | 每次（含签名链接消费）都做 `id + user_id` 归属查询；他人 → 404 |
| 签名 URL 长期泄露 | TTL ≤ 300 秒；过期 403；签名不绑定授权，仍需会话 |
| 签名/URL 进入日志 | 路由不记录；logger redact `signature/signedUrl/signed_url` |
| 存储 key 穿越 | key 全部服务端生成；`assertSafeKey` 拒绝 `..`、`\`、`:`、空段 |
| 大文件 / 伪装类型 | 2 MB 上限 + 白名单 + magic-byte 嗅探（不符即拒绝） |
| 恶意内容被内联执行 | `Content-Disposition: attachment` + `nosniff`，绝不 inline |
| 孤儿文件无限积累 | 30 天保留策略（未关联 / owner 行已删），行先删对象后删 |
| 恶意文件名（`../`/SQL/HTML） | 文件名只作展示标签；key 与 SQL 均不拼接文件名；下载头净化 |
| 病毒/木马 | **未实现扫描**（见第 6 节，明确的已知限制） |
