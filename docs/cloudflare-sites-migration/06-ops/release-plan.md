# Peak Lake 博客 Cloudflare 迁移方案

## 0. 版本与评审

- v0.1，2026-10-28：按用户“官网、博客迁到 Cloudflare，后端先不动”准备。
- 用户随后询问 Vercel Pro，正在等待部署平台选择；状态 `awaiting-review`。未发布 Cloudflare 预览或生产，未修改正式 DNS / Route。
- 代码基线：`17c5568daafe9dd51f4e49220debf520a2939d08`，远端默认分支 `main`，新分支 `feature/cloudflare-sites-migration`。

## 1. 目标与范围

静态页面由 Cloudflare Workers Static Assets 提供；GitHub Actions 构建并上传，避免继续触发 Vercel 前端自动部署。保留现有后端及下载、语言、SEO 和文章路径。若用户选择留在 Vercel Pro，则不应用这份迁移候选。

## 2. 调用链与关联系统

| 系统 | 决策 | 依据 |
|---|---|---|
| 本站静态页面 | 阻断 | 配置完成，等待用户选择 Cloudflare 或 Vercel Pro |
| 本站 `/api/*`（博客） | 不发布（证据） | api 源码未修改，原 Vercel deployment 保留 |
| 原站 telemetry | 不发布（证据） | Cloudflare 构建关闭 Vercel SDK；必要历史路径仍支持回源 |
| Core Web / 桌面 / 移动 App | 不发布（证据） | 本次只改变静态站点托管，不改变三端行为与安装包 |
| 主服务、Auth、AI、邮件、DB、R2 | 不发布（证据） | 未改动其代码、配置、DNS、凭据、版本或数据 |

事实入口：`https://www.peak-lake.com`。当前 Vercel deployment `dpl_J5oLyYmtypxZVkSd8wnKrHu1eTAz`。DNS CNAME `cname.vercel-dns.com`。Cloudflare Worker `peak-lake-blog`，生产 Route `www.peak-lake.com/*`；保留 DNS origin，不能替换为 Custom Domain 后继续同域 fetch。

## 3. 环境与数据

- Preview 使用独立 `peak-lake-blog-preview` Worker、无生产 routes、`noindex`、禁止后端写操作。允许只读健康检查与公开评论读取，必须记录生产后端只读复用例外。
- Production 使用 `peak-lake-blog`，保留 origin / API。博客需把原 www CNAME 从 DNS-only 改为 proxied，官网原本已 proxied。
- 仅迁移公开 GA 配置；服务端 GitHub token、写作口令、数据库变量不进入 Cloudflare。部署 token 放 CI Secret。
- 无数据库 migration、回填或内容变更。

## 4. 顺序与退出条件

确认平台选择 → 提交候选并创建 Code PR → 构建并发布隔离预览 → 页面/API 验证 → 合并默认分支 → 从精确 merge commit 构建 → 生产 route/proxy 切换 → 固定域名回归 → 记录平台版本、commit、CI 与回滚点。

## 5. 验证

已完成本地 build、Worker dry-run、代理保护测试和本地 Cloudflare runtime 静态资源/路径检查。后续以 `05-testing/test-report.md` 回填真实预览与生产证据；本地通过不代表迁移完成。

## 6. 回滚

撤销新增 `www.peak-lake.com/*` Route，保留原 CNAME；博客必要时恢复原 `proxied=false`。原 Vercel deployment 不删除、不重部署。需要恢复原自动部署时移除候选中的 `git.deploymentEnabled=false`，并暂停 Cloudflare workflow。

## 7. 评审结论

当前只完成可逆准备。发布方案未批准、无域名变更、无生产发布。等待用户平台选择后再冻结候选并执行。

## 8. 发布核销

未发布，禁止填写 complete。候选 `__deployment.json` 和 `.cloudflare/deployment-manifest.json` 用于源码 commit / 环境 / 文件摘要映射；生产部署脚本要求当前 HEAD 等于远端默认分支。
