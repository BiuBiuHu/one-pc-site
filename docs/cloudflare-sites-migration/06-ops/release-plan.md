# Peak Lake 博客 Cloudflare 发布方案

## 0. 范围、授权与候选

2026-10-28 v1.0，状态 `approved`。用户本轮明确要求“评估完后，先把博客迁移过去”，授权博客隔离预览和生产迁移。实现、测试、Code PR归并与必要域名切换在该范围内；安排官网及其他后端继续原平台。已获批的全应用方案和P0/P1结果作为上位依据，本轮只执行博客子集。

基线 `17c5568daafe9dd51f4e49220debf520a2939d08`，仓库 `BiuBiuHu/one-pc-site`，默认分支main。新分支从同步main创建，原准备候选8b026a7已保存并复用，bundle保存点在任务的cloudflare-p0p1目录。候选为本Code PR已提交head；部署时由manifest和平台版本保存精确SHA。生产必须先归并默认分支，不能从未归并PR或本地改动发布。

## 1. 发布矩阵与依赖闭包

| 系统 | 决策 | 依据与动作 |
|---|---|---|
| www.peak-lake.com静态页面 | 发布 | Workers Static Assets；三语言、文章URL、RSS/sitemap/SEO保持 |
| 六个博客API | 发布 | Worker原生执行health/list/get/post/delete/comments，复用handler；无Vercel回源 |
| GitHub文章/评论存储 | 不发布（证据） | provider与正式main内容保留；凭据安全注入，评论snapshot与冲突重试修复在同次API候选内 |
| 写作提交后的构建 | 发布 | GitHub Actions构建上传；文章提交触发，comments.json和docs-only不触发；第一次切流前自动生产开关关闭 |
| 裸域peak-lake.com | 发布 | Cloudflare Single Redirect保留路径/query跳转www，DNS改proxied CNAME至www，退出Vercel依赖 |
| GA | 发布 | 保持原公开measurement配置；预览禁用，不迁移服务端secret到静态包 |
| Vercel博客旧项目 | 不发布（证据） | 保留原serving deployment作回滚，不重部署；git.deploymentEnabled=false阻止新构建 |
| Web/桌面/App | 不发布（证据） | 博客为独立Web内容站，入口清单无独立桌面或原生博客客户端；安排三端行为/安装包未改 |
| 安排官网、Core/Auth/AI/Email、PG/R2、支付 | 不发布（证据） | 博客接口只依赖GitHub，站内外链不改；无代码、回调、域名或数据动作 |

调用闭包：读者→博客静态资源/评论API→GitHub comments.json；作者→write→同域博客API→GitHub文章Contents API→main push→GitHub Actions→Cloudflare版本。反向扫描package/lock、vercel redirects/构建、Worker/env、写作与Comments调用，未发现PG、统一认证、Cron、模型或支付依赖。

## 2. 环境与凭据

- Preview：peak-lake-blog-preview，无域名，noindex、无GA；绑定cf-validation-20261028隔离分支，实际写入只在该分支。正式main的文章和comments.json不变。
- Production：peak-lake-blog，原GH_TOKEN/WRITE_PASSWORD安全注入，正式GH_BRANCH=main，保留原口令。Cloudflare现有受限token用于脚本部署，DNS/规则操作使用已登录控制台，仅本博客zone。凭据文件在仓库外mode600目录，不进入代码、产物和日志。
- 正式www使用Custom Domain；原CNAME与新绑定冲突，先上传production无域名候选并验证，再按快照核验现有记录；正式尝试已证实平台100117不允许自动替换，随后按备份删除旧CNAME并立即以Custom Domain API绑定成功。若绑定失败必须恢复旧DNS记录。裸域保持原跳转语义。其他DNS记录不改。
- 不做PG迁移，不改正式文章/评论。预览写作/编辑/删除和并发评论仅写隔离分支；验证后关闭写入并删除隔离分支。

## 3. 顺序与门禁

1. 保存旧DNS/路由/serving/GA和本地代码，完成本地测试、静态构建、Worker dry-run与自审。
2. 提交并创建Code PR，部署隔离Preview（不先归并，避免提前触发正式构建），完成页面、API、隔离真实写作/评论与浏览器验收。
3. 预览通过后归并Code PR，主分支pull到精确merge SHA；重建production产物并扫描secret。运行发布完整性检查，先用--stage-only部署无域名production候选。
4. 验证production workers.dev健康和只读写作/评论，检查版本/摘要，再以平台API绑定www Custom Domain，并创建cloudflare/apex-redirect.json中的裸域308规则与CNAME。失败立即按第5节回滚。
5. 固定域名复测、受控作者只读验证、无副作用探针、日志和GitHub内容前后检查；启用自动生产构建，手动触发一次真实Actions验证。
6. 发布证据用独立Release PR回填，核对主干/worktree、实际版本、CI、域名漂移。旧Vercel资源保留至少14天，本轮不删除。

## 4. 验收

必须通过：三语言首页/列表/文章、深链接刷新、JS/CSS/图片、真实404、60条历史跳转、canonical/hreflang、robots/llms/RSS/sitemap、六个API与写作鉴权、UTF-8、更新SHA、评论冲突重试、预览生产隔离、写作提交触发构建而评论不触发、部署源码与产物指纹一致。具体用例和未执行项见测试策略/报告。

## 5. 回滚

切流失败时暂停Cloudflare自动生产开关。删除本轮www Worker Custom Domain，恢复备份CNAME（cname.vercel-dns.com, DNS-only）并核验。删除仅本轮创建的裸域redirect规则，恢复裸域原CNAME/proxy。原Vercel serving deployment保留并复测；不覆盖GitHub已产生内容。若切流后作者有新文章，按恢复后的默认分支重新部署旧平台，不能把旧静态deployment当作包含新文章。Worker回滚保存version与artifact摘要。

## 6. 执行记录

生产已部署，Code PR #34/#35已归并默认分支；精确source **1dd26827e8d5b498c72673a043d27b1034364481**，CI run **40626736033** 成功，实际Worker版本 **5ac5427c-4116-4d89-8bb9-8706fde18475**。域名、静态/API/SEO、内容hash与短时日志验收已回填测试报告。发布证据通过独立Release PR归档，最后再核对主干和worktree。

正式www绑定id为4bc22da62fceec99cf2fcacd8589322f634c207a；裸域redirect ruleset为e11aff58d39a4a67b5e06128a8433d68。自动生产开关已开启，comments/docs-only不触发构建。原Vercel项目与旧deployment保留，Git自动部署连接在核对后断开。
