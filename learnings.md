# Learnings

## 2026-08-23 · CI/依赖审计(timemark-vercel)

- **pnpm `blockExoticSubdeps=false` 的根因**:`backend/package.json` 的 optionalDependencies 里 baileys/oicq/wechaty 会拉取 git-hosted 子依赖触发 `ERR_PNPM_EXOTIC_SUBDEP`。这三个包仍被 `src/services/notifications/{whatsapp,wechaty,qqbot}.service.ts` 引用(仅类型/动态导入),因此不能直接删除依赖;正确路径是连同这三个死渠道服务一起移除后再删掉 `.npmrc` 覆盖与各处安装 flag(ci.yml / vercel.json installCommand / 根 package.json install:deps)。
- **仓库里没有 Dockerfile 却保留 `.github/workflows/docker.yml`** → 每次 push/tag CI 必红。产品自 v2.12.0 起已移除 Docker 形态(见 README),流水线应随代码形态走。
- **engines 只钉 pnpm 不钉 node**:CI 用 Node 22 而 Vercel 运行时跟随 engines/settings,应显式 `"node": ">=22"`;`@types/node` 大版本要跟运行时对齐(^22)。
- **tsc --noEmit 应进 CI 门禁**:`routes/auth.ts` 漏 import `verifyUserPassword`(2e3dc31 引入)导致 backend 构建在本地必挂,却没有任何门禁拦住。
- 审计工作流:改 lockfile 后先跑 `pnpm install --frozen-lockfile` 验证一致性,再跑 `tsc --noEmit`;两者都是廉价高信噪比的回归闸门。

## 模板(后续条目按此格式追加)

```
## YYYY-MM-DD · <主题>
- <事实/教训,带 file:line>
- <验证命令与结果>
```
