# 博客 Cloudflare 迁移测试报告

2026-10-28。当前为本地与隔离预览准备阶段，生产未切换。

- 12项原生Worker/共享API直接回归通过，涵盖隔离、鉴权、UTF-8、写作SHA、评论并发冲突/读失败保护、非法路径、请求正文边界和404。
- Astro静态构建通过，62个页面；保留60条历史redirect，manifest记录187个文件。
- Wrangler4.83.0 preview dry-run通过，nodejs_compat与六个API打包成功，无容器依赖。
- 尚未执行的真实Preview、域名、作者读取、CI与日志检查继续回填；没有在正式main新建文章或评论。

## 已部署Preview

- source `e15f4567556596dd05018f02811075862bcabb49`，Worker `peak-lake-blog-preview`，版本 `7793a936-7007-49ab-be45-f90e76f03b1f`。
- `check-cloudflare.mjs`：184页面/资源、60redirect与404、source/target/noindex通过；真实浏览器首页和写作编辑器可用。
- 浏览器真实API 11项：隔离新建→UTF-8读取→更新→列表→两条评论→删除→404通过，全部针对cf-validation-20261028，生产写入0。作者UI加载46篇文章。
- 原生客户端可直接访问本轮Worker，无P0/P1容器测试时的403问题。运行日志采集8个主动探针事件，异常0、非ok结果0；短时检查不证明长期稳定性。
- 正式46个Markdown文件SHA及comments.json SHA在预览写入前后完全一致。候选后续仅增加可复跑检查脚本、裸域规则定义与证据；发布前再次核对source指纹。

- SEO 13条路径检查通过，写作页保留原noindex且不要求hreflang；原生客户端12条真实API验证通过。浏览器作者读取文章进入编辑状态、正文可见。
- 后续增补只有测试脚本、裸域规则和执行证据，核心Worker/handler与上述Preview相同；发布最终候选时更新source指纹并核验。
