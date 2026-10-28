# 博客 Cloudflare 运行记录

正式入口：[www.peak-lake.com](https://www.peak-lake.com)，写作入口仍为 `/write`，原口令保持。页面、六个API和裸域跳转均由Cloudflare承接，内容仍存GitHub，没有容器或数据库迁移。

生产源码：`1dd26827e8d5b498c72673a043d27b1034364481`，Code PR #34/#35已归并main。实际Worker版本：`5ac5427c-4116-4d89-8bb9-8706fde18475`。[真实CI运行](https://github.com/BiuBiuHu/one-pc-site/actions/runs/40626736033)。

- [发布与回滚](06-ops/release-plan.md)
- [测试报告](05-testing/test-report.md)
- [测试策略](05-testing/test-strategy.md)
- [发布证据](04-engineering/evidence/production-platform.json)

main文章提交触发GitHub Actions；comments.json与docs-only提交跳过，仓库变量CLOUDFLARE_PRODUCTION_ENABLED控制自动生产。服务端GH_TOKEN/WRITE_PASSWORD保存在Worker Secret，CI部署token保存在GitHub Secret；本机临时凭据已清理。原Vercel Git连接已断开，旧deployment保留至少14天。

本轮Preview为临时环境，已删除Worker与隔离数据分支。今后重新验证Preview前，先创建与main隔离的内容分支、核对wrangler的GH_BRANCH并安全设置预览secret，再手动部署。不能省略这些准备后拿生产分支做写入测试。

短时回归已通过，未声称完成长期SLO或GA后台归因验收。回滚时先关闭Cloudflare自动生产开关；按快照撤销新增域名绑定/redirect并恢复原DNS，必要时重新连接原Vercel Git仓库并恢复其deploymentEnabled配置。若切流后有新文章，恢复发布须包含新内容，不能仅指向旧静态部署。
