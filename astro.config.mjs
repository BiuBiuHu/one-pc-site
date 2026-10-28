import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import { lastmodForUrl } from "./src/data/sitemap-lastmod.js";

// Cloudflare Static Assets serves pages; the same Worker runs the blog APIs.
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
