// 站点配置 —— 替换为你自己的信息即可
export const site = {
  name: "One PC",
  // 你的 GitHub 用户名（评论 Giscus 和后台 Decap 都要用）
  githubUser: "BiuBiuHu",
  // 仓库名
  repo: "one-pc-site",
  email: "biubiu_hu@qq.com",
  // 全站 og/twitter 兜底图（单页可覆盖）
  ogImage: "/images/og-default.png",
  // GitHub 个人主页
  get githubUrl() {
    return `https://github.com/${this.githubUser}`;
  },
  // 仓库完整地址（公开仓库）
  get repoUrl() {
    return `https://github.com/${this.githubUser}/${this.repo}`;
  },
  // Person / BlogPosting author.sameAs，与 About JSON-LD 对齐
  get sameAs() {
    return [this.githubUrl, `https://github.com/${this.githubUser}/opc-skills`, "https://www.anpai.life/"];
  }
};
