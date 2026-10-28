# 博客迁移验证策略

本次影响静态托管、六个API、GitHub写入与CI/域名。优先验证迁移闭环与副作用，使用等价类、边界值和冲突状态迁移。12项本地测试复用真实Worker/handler，provider返回值模拟成功、401/403/409、UTF-8与缺失配置；实际Preview再验证GitHub链路，不能以构建成功替代。

| ID | 优先级 | 前提、步骤 | 必须结果/副作用断言 | 证据 |
|---|---|---|---|---|
| BLOG-01 | P0 | Preview构建并部署；请求全部静态路径、资源、三语言、深链接与未知路径 | 正常200，未知404，预览noindex，production无noindex；资源无secret | check-cloudflare输出、浏览器snapshot |
| BLOG-02 | P0 | 访问60条原vercel重定向和SEO文件 | 状态/目标一致，canonical/语言/RSS/sitemap正确 | 静态检查与响应 |
| BLOG-03 | P0 | 缺secret、错误口令、非法slug、畸形/超1MiB正文 | 503/401/400/413；不能触发GitHub写入 | worker.test.mjs |
| BLOG-04 | P0 | Preview绑定隔离分支；真实新建→读取→更新→删除文章 | 中文/日文不损坏，sha连续更新；正式main内容不变 | 预览API结果、GitHub前后hash |
| BLOG-05 | P0 | 隔离分支写两条评论并读取，模拟409后重读重试 | 已有评论不丢；读取失败不覆盖为空；正式comments.json不变 | 单测、真实API/存储摘要 |
| BLOG-06 | P0 | Preview误配main/空branch发写请求 | 必须403，不访问provider | 单测 |
| BLOG-07 | P0 | 合并后production无域名阶段验证健康、口令读取列表/文章、公开评论 | 命中Cloudflare本地API，无Vercel依赖，无生产写入 | API响应/Worker version/manifest |
| BLOG-08 | P0 | www与裸域切流、固定域名再次检查 | www指向Worker；裸域保留path/query跳www，原Vercel仍可回滚 | DNS/domain/rule API证据 |
| BLOG-09 | P1 | 开启生产自动构建并手动dispatch主干生产 | CI成功、manifest/source SHA/实际version一致；配置排除comments/docs-only | Actions run/平台inspect |
| BLOG-10 | P1 | 浏览器作者入口加载已有文章列表并读取；固定入口无副作用探针与日志 | 作者真实只读路径可用，无secret写入证据，main数据无漂移 | 浏览器语义摘要/脱敏日志 |

不测：安排客户端/后台/PG/支付/模型/邮件没有依赖变化；不重新运行全应用26用例。正式写文章和新增真实评论不用于探针，写入能力由隔离分支验证；首轮不是7天稳定性保证。错误按静态资源、Worker路由/配置、GitHub权限/冲突、CI或DNS分层归因，P0失败停止切流并回滚。秘密只在仓库外受限文件，报告不记录带口令的完整URL。
