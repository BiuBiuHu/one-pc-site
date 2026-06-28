import { defineConfig } from "astro/config";

// 纯静态输出：SSG，部署到 Vercel。/api 下的 OAuth 代理与 health 由 Vercel serverless 函数承载。
export default defineConfig({
  site: "https://blog-orcin-eta-43.vercel.app",
  output: "static",
  markdown: {
    shikiConfig: {
      theme: "github-dark",
      wrap: true
    }
  }
});
