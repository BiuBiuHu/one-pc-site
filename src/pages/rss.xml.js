import rss from "@astrojs/rss";
import { getCollection } from "astro:content";
import { site } from "../data/site";

export async function GET(context) {
  const posts = (await getCollection("blog"))
    .filter((p) => (p.data.lang ?? "zh") === "zh")
    .sort((a, b) => b.data.date.getTime() - a.data.date.getTime());

  return rss({
    title: `${site.name} · 博客`,
    description: "One PC 的个人站点 —— 开源项目、AI 工作流、产品与日常思考。",
    site: context.site,
    items: posts.map((post) => ({
      title: post.data.title,
      pubDate: post.data.date,
      description: post.data.excerpt || "",
      link: `/blog/${post.id}`
    })),
    customData: `<language>zh-CN</language>`
  });
}
