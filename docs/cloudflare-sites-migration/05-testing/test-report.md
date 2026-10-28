# 博客 Cloudflare 迁移测试报告

2026-10-28。状态：博客已迁至Cloudflare并通过本轮发布验收；下列早期记录保留为执行历史。安排等其他应用未切换。

- 12项原生Worker/共享API直接回归通过，涵盖隔离、鉴权、UTF-8、写作SHA、评论并发冲突/读失败保护、非法路径、请求正文边界和404。
- Astro静态构建通过，62个页面；保留60条历史redirect，manifest记录187个文件。
- Wrangler4.83.0 preview dry-run通过，nodejs_compat与六个API打包成功，无容器依赖。
- 准备阶段尚未执行的真实Preview、域名、作者读取、CI与日志检查，现已在后续章节回填；没有在正式main新建文章或评论。

## 已部署Preview

- source `e15f4567556596dd05018f02811075862bcabb49`，Worker `peak-lake-blog-preview`，版本 `7793a936-7007-49ab-be45-f90e76f03b1f`。
- `check-cloudflare.mjs`：184页面/资源、60redirect与404、source/target/noindex通过；真实浏览器首页和写作编辑器可用。
- 浏览器真实API 11项：隔离新建→UTF-8读取→更新→列表→两条评论→删除→404通过，全部针对cf-validation-20261028，生产写入0。作者UI加载46篇文章。
- 原生客户端可直接访问本轮Worker，无P0/P1容器测试时的403问题。运行日志采集8个主动探针事件，异常0、非ok结果0；短时检查不证明长期稳定性。
- 正式46个Markdown文件SHA及comments.json SHA在预览写入前后完全一致。候选后续仅增加可复跑检查脚本、裸域规则定义与证据；发布前再次核对source指纹。

- SEO 13条路径检查通过，写作页保留原noindex且不要求hreflang；原生客户端12条真实API验证通过。浏览器作者读取文章进入编辑状态、正文可见。
- 后续增补只有测试脚本、裸域规则和执行证据，核心Worker/handler与上述Preview相同；发布最终候选时更新source指纹并核验。

## Production发布与回归

- Code PR #34合并为232c42f，bootstrap参数修复PR #35合并为 **1dd26827e8d5b498c72673a043d27b1034364481**；运行时与已验收Preview一致。首次空routes CLI参数失败发生于上传前；修复用明确空routes配置，production无域名上传与8条只读API/13条SEO检查通过。
- Custom Domain自动替换CNAME被平台100117拒绝，未改变原域名记录。随后依据备份删除www旧CNAME并立即用正式域名API绑定成功；未执行失败回滚，旧Vercel部署保留。
- www.peak-lake.com → peak-lake-blog Custom Domain；裸域proxied CNAME至www，并由Cloudflare Single Redirect以原308保留路径/query跳转。原验证TXT保持。
- 固定域名184页面/资源、60历史跳转、真实404与部署指纹通过；13条SEO检查、8条API检查通过。真实浏览器文章与评论加载正常，命中production指纹。
- 生产写入0，46个Markdown文件SHA、正式comments.json SHA前后不变；隔离分支完成真实CRUD/UTF-8/评论，已删除。
- 已启用自动生产构建开关，并实际完成 [Actions run 40626736033](https://github.com/BiuBiuHu/one-pc-site/actions/runs/40626736033)。CI精确source为1dd2682，186个文件，assetsSha256为5415f2a378144a5dab633bf28f870c6d03e6171877ee2e3c4fe27810879c090d。
- CI发布版本 **5ac5427c-4116-4d89-8bb9-8706fde18475**，平台active version一致。CI后再次8条正式只读API通过，未重新运行无变化的全量静态测试。
- 已采集8条正式主动探针实时事件，exceptions=0、outcome均ok。此为短时观察，不代表7天SLO；GA配置与构建脚本保留，未以SDK加载冒充GA后台归因验收。
- 验证Preview Worker和cf-validation-20261028分支已删除；未来新建Preview须先准备隔离分支和Worker secrets，自动workflow不会擅自复制生产内容或密码。

执行证据均在相邻 `04-engineering/evidence/`；不包含凭据、带口令URL或日志正文。正式发布及数据核对通过，保留旧平台回滚资源至少14天，长期可用性需继续实际观察。本次没有新增容器或付费套餐，博客使用既有Workers Paid；最终增量计费以平台账单为准。

Vercel博客Git连接已实际断开并通过平台API复核，旧deployment仍READY；不以CLI退出码或仓库配置代替该证据。

正式作者UI加载46篇文章，原草稿恢复正常，未编辑草稿或发送写请求。临时凭据、Preview Worker与测试分支均已清理；部署token和正式Worker secrets保留在各自安全位置。

## 发布收尾补查：脚本客户端

Python urllib默认客户端在正式域名和workers.dev均返回403/1010；浏览器和Node成功不能替代此失败。读取到本博客zone的browser_check=on。官方1010文档与BIC说明确认此类客户端可能被拦截。拟仅在公开博客zone将browser_check关闭，保留写作鉴权、其他WAF/DDoS设置；不伪装客户端UA。workers.dev内置策略不可由站点关闭，正式自有域名才作为客户端兼容验收入口。操作前后响应与配置状态继续回填。
