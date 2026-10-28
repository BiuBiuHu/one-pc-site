# 本地迁移验证

日期：2026-10-28。范围：静态托管、历史跳转、边缘回源、环境与版本保护。

- `npm run test:cloudflare`：3 项通过。覆盖 POST 方法/body/query/cookie 保留、API no-store、预览拒绝写入、真实 404。
- `npm run build:cloudflare`：通过，独立输出 `.cloudflare/assets`，未覆盖原构建目录。
- `wrangler deploy --env preview --dry-run`：通过，只打包，无共享环境发布。
- `node scripts/check-cloudflare.mjs http://localhost:8788`：184 个页面/资源和 60 条历史重定向通过；未知页面返回 404。
- 后续增加环境指纹、preview noindex 和摘要部署校验，最终提交后需要重建并复验。
- 未执行：Cloudflare 共享预览、固定生产域名回归、发布/删除文章或写评论。原因：用户正在比较 Vercel Pro；写操作会产生生产副作用，不用于探测。
- 生产 DNS、Route、Vercel backend deployment 均未修改。尚不能宣称迁移成功。
