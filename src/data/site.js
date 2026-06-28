// 站点配置 —— 替换为你自己的信息即可
export const site = {
  name: "One PC",
  // 你的 GitHub 用户名（评论 Giscus 和后台 Decap 都要用）
  githubUser: "BiuBiuHu",
  // 仓库名
  repo: "one-pc-site",
  email: "hello@onepc.dev",
  // 仓库完整地址（公开仓库，Giscus/Decap 依赖）
  get repoUrl() {
    return `https://github.com/${this.githubUser}/${this.repo}`;
  },
  // Giscus 配置 —— 在 https://giscus.app 生成后填这两项
  giscus: {
    repoId: "", // TODO: 在 giscus.app 生成
    category: "Announcements",
    categoryId: "" // TODO: 在 giscus.app 生成
  },
  // Decap CMS 后台的 OAuth 代理地址（部署后用线上域名）
  oauthProxy: "/api/auth"
};
