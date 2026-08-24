// 开源项目数据 —— 改成你的真实项目
export const projects = [
  {
    name: "Anpai.Life",
    tagline: "AI 驱动的跨端任务管理",
    description:
      "任务 + 日历 + AI 规划的效率应用，PC 与客户端同步，支持自然语言建任务和智能排期。",
    language: "TypeScript",
    languageColor: "#3178c6",
    repo: "",
    homepage: "https://www.anpai.life/",
    tags: ["效率", "跨端", "AI"],
    status: "active",
    featured: true
  },
  {
    name: "OPC Skills",
    tagline: "C 端 + B 端研发流水线 Codex Skill",
    description:
      "面向 OPC/Dida 类产品的 Codex Skill，把需求澄清、产品设计、B 端运营页、架构治理、研发、测试、联调、发布门禁串成一套可复用工作流，让 Agent 在复杂业务里持续做正确判断。",
    language: "Shell",
    languageColor: "#89e051",
    stars: 1,
    repo: "https://github.com/BiuBiuHu/opc-skills",
    homepage: "",
    tags: ["Skill", "研发流水线", "Agent"],
    status: "active",
    featured: true
  },
  {
    name: "AI Gateway",
    tagline: "统一的多模型中转网关",
    description:
      "把多家大模型统一接入，集中处理密钥、限流、日志和成本治理，让业务侧只关心调用。",
    language: "TypeScript",
    languageColor: "#3178c6",
    stars: 128,
    repo: "https://github.com/BiuBiuHu/ai-gateway",
    homepage: "",
    tags: ["AI", "Gateway", "LLM"],
    status: "active",
    featured: true
  },
  {
    name: "Mail Service",
    tagline: "开箱即用的交易邮件服务",
    description:
      "轻量的邮件发送 API 与模板系统，支持验证码、通知和营销邮件，带送达追踪与重试。",
    language: "Go",
    languageColor: "#00add8",
    stars: 64,
    repo: "https://github.com/BiuBiuHu/mail-service",
    homepage: "",
    tags: ["Email", "API", "基础设施"],
    status: "active",
    featured: true
  }
];

export function getFeaturedProjects(limit = 3) {
  return projects.filter((p) => p.featured).slice(0, limit);
}

export function statusLabel(status) {
  return status === "wip" ? "开发中" : "维护中";
}
