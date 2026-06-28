// 站点配置 —— 替换为你自己的信息即可
export const site = {
  name: "One PC",
  // 你的 GitHub 用户名（评论 Giscus 和后台 Decap 都要用）
  githubUser: "BiuBiuHu",
  // 仓库名
  repo: "one-pc-site",
  email: "biubiu_hu@qq.com",
  // 仓库完整地址（公开仓库）
  get repoUrl() {
    return `https://github.com/${this.githubUser}/${this.repo}`;
  }
};
