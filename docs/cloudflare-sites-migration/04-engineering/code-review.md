# 博客 Cloudflare 迁移代码自审

2026-10-28。当前为主Agent自审，未声称独立人工review。生产前创建Code PR，并在预览通过后归并默认分支。

复核范围：API工厂使用请求级env，Vercel与Worker共享handler，无跨环境process.env修改；Worker六条原生路由无旧平台fetch；静态优先、真实404、no-store；预览main写入保护、缺凭据fail-closed、slug限制与1MiB正文限制；base64使用node:buffer保证中文；评论使用同一GitHub快照内容/SHA与有限冲突重试，读取错误不覆盖原评论。没有迁移数据库、真实文章或用户身份。

生产域名Custom Domain与CNAME冲突以先无域名部署、再切流处理；裸域单独redirect保持路径/query。原Vercel部署保留；自动生产开关在首轮验证前保持关闭。构建记录source/target/摘要，production要求当前远端默认分支精确SHA。预览禁用GA/noindex，production重建清除预览_headers。

风险：GitHub为写作与评论存储，存在API限额和短时上游故障；并发冲突重试最多3次，持续冲突返回可重试503。正式写操作不作探针，隔离分支执行真实CRUD。依赖原有GA与外链服务，未更换第三方。旧Vercel资源至少14天保留。

本地12项直接测试已通过，构建和dry-run通过；真实Preview/Production证据待测试报告回填。未发现阻止部署隔离Preview的已知P0；生产须等Preview验收。
