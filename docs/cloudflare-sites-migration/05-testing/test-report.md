# 博客 Cloudflare 迁移测试报告

2026-10-28。当前为本地与隔离预览准备阶段，生产未切换。

- 12项原生Worker/共享API直接回归通过，涵盖隔离、鉴权、UTF-8、写作SHA、评论并发冲突/读失败保护、非法路径、请求正文边界和404。
- Astro静态构建通过，62个页面；保留60条历史redirect，manifest记录187个文件。
- Wrangler4.83.0 preview dry-run通过，nodejs_compat与六个API打包成功，无容器依赖。
- 尚未执行的真实Preview、域名、作者读取、CI与日志检查继续回填；没有在正式main新建文章或评论。
