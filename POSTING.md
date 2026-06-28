---
name: posting
description: One PC 个人站点的发文与写作指南
---

# 写作 / 发文指南

本站点基于 Astro + Markdown。两种写作方式：

## 方式一：网页后台编辑器（推荐）

访问 `/admin`（Decap CMS），在浏览器里写文章、填 frontmatter，提交即发布。
需要先在 GitHub 上配置好仓库与 OAuth（见 `docs/` 部署记录）。

## 方式二：本地写 Markdown

在 `src/content/blog/` 下新建 `.md` 文件，frontmatter 格式：

```markdown
---
title: 文章标题
date: 2026-05-23
excerpt: 一句话摘要（可选）
---

正文内容……
```

然后：

```bash
npm run build      # 本地预览
vercel --prod      # 部署
```

## 内容约定

- 文件名即 slug（如 `my-post.md` → `/blog/my-post`）。
- `date` 用 `YYYY-MM-DD`。
- 图片放 `public/uploads/`，引用 `/uploads/xxx.png`。
- 正文支持 GFM Markdown（表格、代码块等）。
