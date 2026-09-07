import rss from "@astrojs/rss";
import { getCollection } from "astro:content";
import { site } from "../../data/site";

export async function GET(context) {
  const posts = (await getCollection("blog"))
    .filter((p) => p.data.lang === "en")
    .sort((a, b) => b.data.date.getTime() - a.data.date.getTime());

  return rss({
    title: `${site.name} · Blog`,
    description: "One PC — open source projects, AI workflows, products, and daily thoughts.",
    site: context.site,
    items: posts.map((post) => ({
      title: post.data.title,
      pubDate: post.data.date,
      description: post.data.excerpt || "",
      link: `/en/blog/${post.id.replace(/-en$/, "")}`
    })),
    customData: `<language>en-US</language>`
  });
}
