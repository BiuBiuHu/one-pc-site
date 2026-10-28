import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import { lastmodForUrl } from "./src/data/sitemap-lastmod.js";

// 静态页面部署到 Cloudflare；/api 通过 Worker Route 回源现有 Vercel 服务。
export default defineConfig({
  site: "https://www.peak-lake.com",
  output: "static",
  i18n: {
    defaultLocale: "zh",
    locales: ["zh", "en", "ja"],
    routing: { prefixDefaultLocale: false }
  },
  integrations: [
    sitemap({
      filter: (page) => !page.includes("/write"),
      i18n: {
        defaultLocale: "zh",
        locales: {
          zh: "zh-CN",
          en: "en-US",
          ja: "ja-JP"
        }
      },
      serialize(item) {
        item.lastmod = lastmodForUrl(item.url);
        return item;
      }
    })
  ],
  markdown: {
    shikiConfig: {
      theme: "github-dark",
      wrap: true
    }
  }
});
