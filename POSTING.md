---
name: posting
description: One PC 个人站点的发文与写作指南
---

# 写作 / 发文指南

本站点基于 Astro + Markdown。两种写作方式：

## 方式一：网页写作页（推荐）

访问 `/write`：Vditor 即时渲染编辑器，打字时 Markdown 标记自动隐藏，写什么即看到什么。
草稿自动存浏览器本地（刷新不丢），想清楚了填写作口令一键发布，自动提交到仓库并部署上线。
需要写作口令（环境变量 `WRITE_PASSWORD`）。

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
