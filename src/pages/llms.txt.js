import { getCollection } from "astro:content";
import { site } from "../data/site";
import { localeOf, postSlug } from "../lib/i18n.js";

function blogUrl(base, post) {
  const slug = postSlug(post.id);
  const lang = localeOf(post);
  if (lang === "en") return `${base}/en/blog/${slug}/`;
  if (lang === "ja") return `${base}/ja/blog/${slug}/`;
  return `${base}/blog/${slug}/`;
}

function langTag(lang) {
  if (lang === "en") return "EN";
  if (lang === "ja") return "JA";
  return "ZH";
}

// llms.txt：让 LLM 爬虫 / AI 工具（agent、IDE）快速读懂站点内容地图
// 规范：https://llmstxt.org
export async function GET(context) {
  const posts = (await getCollection("blog"))
    .filter((p) => !p.data.draft)
    .sort((a, b) => b.data.date.getTime() - a.data.date.getTime());
  const jaPosts = posts.filter((p) => localeOf(p) === "ja");
  const base = context.site.origin;

  const out = [];
  out.push(`# ${site.name}`);
  out.push("");
  out.push("> 独立开发者的个人站点，内容为第一手 AI 工程实践（Agent、意图识别、AI 工作流、产品开发）与开源项目。");
  out.push("");
  out.push("## 关于");
  out.push("");
  out.push(`- 作者：${site.name}（GitHub: ${site.githubUrl}）`);
  out.push(`- 联系：${site.email}`);
  out.push("");
  out.push("## 核心页面");
  out.push("");
  out.push(`- [首页](${base}/): 站点首页`);
  out.push(`- [关于](${base}/about/): ${site.name}，Agent engineer · OPC`);
  out.push(`- [About](${base}/en/about/): English about`);
  out.push(`- [博客](${base}/blog/): 全部文章归档（按分类）`);
  out.push(`- [项目](${base}/projects/): 开源项目`);
  out.push(`- [OPC Skills](${base}/projects/opc-skills/): BiuBiuHu 的 OPC 交付 Codex Skill 模板（非 opc.dev）`);
  out.push(`- [OPC Skills (EN)](${base}/en/projects/opc-skills/): OPC Skills landing`);
  out.push(`- [服务](${base}/services/): 可直接使用的服务`);
  out.push("");
  out.push("## Japanese (live pages only)");
  out.push("");
  out.push(`- [日本語ホーム](${base}/ja/): Agent / Skills / OPC の日本語エントリ`);
  out.push(`- [OPC Skills (JA)](${base}/ja/projects/opc-skills/): OPC Skills 日本語`);
  out.push(`- [日本語の記事](${base}/ja/blog/): 公開中の日本語記事（全アーカイブではない）`);
  for (const post of jaPosts) {
    const date = post.data.date.toISOString().slice(0, 10);
    const excerpt = post.data.excerpt || "";
    out.push(`- [JA] [${post.data.title}](${blogUrl(base, post)})（${date}）：${excerpt}`);
  }
  out.push("");
  out.push(`## 博客文章（${posts.length} 篇）`);
  out.push("");
  for (const post of posts) {
    const lang = localeOf(post);
    const date = post.data.date.toISOString().slice(0, 10);
    const excerpt = post.data.excerpt || "";
    out.push(`- [${langTag(lang)}] [${post.data.title}](${blogUrl(base, post)})（${date}）：${excerpt}`);
  }

  return new Response(out.join("\n") + "\n", {
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}
