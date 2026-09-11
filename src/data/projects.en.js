// Open source projects data (English)
export const projects = [
  {
    name: "Anpai.Life",
    tagline: "AI-powered cross-platform task management",
    description:
      "A task + calendar + AI planning productivity app with PC/mobile sync, natural-language task creation, and smart scheduling.",
    language: "TypeScript",
    languageColor: "#3178c6",
    repo: "",
    homepage: "https://www.anpai.life/",
    tags: ["Productivity", "Cross-platform", "AI"],
    status: "active",
    featured: true
  },
  {
    name: "OPC Skills",
    tagline: "Codex Skill for C-side + B-side delivery pipeline",
    description:
      "A Codex Skill for OPC/Dida-style products that chains requirement clarification, product design, B-side ops pages, architecture governance, development, testing, integration, and release gates into one reusable workflow — so agents keep making correct calls in complex business contexts.",
    language: "Shell",
    languageColor: "#89e051",
    stars: 1,
    repo: "https://github.com/BiuBiuHu/opc-skills",
    homepage: "",
    tags: ["Skill", "Delivery Pipeline", "Agent"],
    status: "active",
    featured: true
  },
  {
    name: "AI Gateway",
    tagline: "Unified multi-model gateway",
    description:
      "Connect multiple LLMs in one place, centralizing keys, rate limiting, logging, and cost governance so the business side only cares about calling.",
    language: "TypeScript",
    languageColor: "#3178c6",
    repo: "",
    homepage: "https://apistation.cn/",
    tags: ["AI", "Gateway", "LLM"],
    status: "active",
    featured: true
  },
  {
    name: "Mail Service",
    tagline: "Ready-to-use transactional email service",
    description:
      "A lightweight email API and template system for verification codes, notifications, and marketing, with deliverability tracking and retry.",
    language: "Go",
    languageColor: "#00add8",
    stars: 64,
    repo: "https://github.com/BiuBiuHu/mail-service",
    homepage: "",
    tags: ["Email", "API", "Infrastructure"],
    status: "active",
    featured: true
  }
];

export function getFeaturedProjects(limit = 3) {
  return projects.filter((p) => p.featured).slice(0, limit);
}

export function statusLabel(status) {
  return status === "wip" ? "In progress" : "Maintained";
}
