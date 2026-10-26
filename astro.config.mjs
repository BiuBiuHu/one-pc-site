import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import { lastmodForUrl } from "./src/data/sitemap-lastmod.js";

// 纯静态输出：SSG，部署到 Vercel。/api 下的 OAuth 代理与 health 由 Vercel serverless 函数承载。
export default defineConfig({
  site: "https://www.peak-lake.com",
  output: "static",
  i18n: {
    defaultLocale: "zh",
    locales: ["zh", "en"],
    routing: { prefixDefaultLocale: false }
  },
  integrations: [
    sitemap({
      filter: (page) => !page.includes("/write"),
      i18n: {
        defaultLocale: "zh",
        locales: {
          zh: "zh-CN",
          en: "en-US"
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
