import { getCollection } from "astro:content";
import { site } from "../data/site";

// llms.txt：让 LLM 爬虫 / AI 工具（agent、IDE）快速读懂站点内容地图
// 规范：https://llmstxt.org
export async function GET(context) {
  const posts = (await getCollection("blog"))
    .filter((p) => (p.data.lang ?? "zh") === "zh")
    .sort((a, b) => b.data.date.getTime() - a.data.date.getTime());
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
  out.push(`- [博客](${base}/blog/): 全部文章归档（按分类）`);
  out.push(`- [项目](${base}/projects/): 开源项目`);
  out.push(`- [服务](${base}/services/): 可直接使用的服务`);
  out.push(`- [写作](${base}/write/): 写作`);
  out.push("");
  out.push(`## 博客文章（${posts.length} 篇）`);
  out.push("");
  for (const post of posts) {
    const url = `${base}/blog/${post.id}/`;
    const date = post.data.date.toISOString().slice(0, 10);
    const excerpt = post.data.excerpt || "";
    out.push(`- [${post.data.title}](${url})（${date}）：${excerpt}`);
  }

  return new Response(out.join("\n") + "\n", {
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}
