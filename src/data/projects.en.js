import { hydrateProjectStars } from "../lib/github-stars";
import { OPC_SKILLS_SITE } from "./product-hubs";

// Open source projects data (English)
// stars is a last-resort fallback when the build-time GitHub fetch misses
const projectList = [
  {
    name: "Anpai.Life",
    tagline: "AI-powered cross-platform task management",
    description:
      "A task + calendar + AI planning productivity app with PC/mobile sync, natural-language task creation, and smart scheduling.",
    language: "TypeScript",
    languageColor: "#3178c6",
    repo: "",
    homepage: "https://www.anpai.life/",
    webApp: "https://web.anpai.life/",
    tags: ["Productivity", "Cross-platform", "AI"],
    status: "active",
    featured: true
  },
  {
    name: "Smart Tab Pilot",
    tagline: "Chrome extension for task-based tab management",
    description:
      "Exact URL dedupe across windows plus a learnable task navigation graph. Side panel only; models go on-device Nano → your OpenAI-compatible endpoint → local heuristics.",
    language: "JavaScript",
    languageColor: "#f1e05a",
    repo: "https://github.com/BiuBiuHu/smart-tab-pilot",
    homepage: "https://biubiuhu.github.io/smart-tab-pilot/",
    store: "https://chromewebstore.google.com/detail/smart-tab-pilot/acnhnhllaloccmnmdjcgmkmpbkpdegfd",
    tags: ["Chrome", "Productivity", "AI"],
    status: "active",
    featured: true
  },
  {
    name: "OpenBot",
    tagline: "SSH your own machine so the agent has a computer",
    description:
      "Self-hosted alpha: the agent runs commands, reads and writes files, and drives Chromium on your Linux server, with a visible desktop you can watch or take over. Bring your own model key. Intended for a single user in a trusted environment.",
    language: "TypeScript",
    languageColor: "#3178c6",
    stars: 0,
    repo: "https://github.com/BiuBiuHu/OpenBot",
    homepage: "",
    tags: ["Agent", "SSH", "Self-hosted"],
    status: "wip",
    featured: true
  },
  {
    name: "OPC Skills",
    tagline: "Skill pack for coding agents doing OPC delivery",
    description:
      "BiuBiuHu's skill pack for coding agents (Codex, Cursor, Claude, and others that can load it) at github.com/BiuBiuHu/opc-skills — not ReScienceLab / opc.dev. It is for shipping C-end products together with B-side consoles, chaining requirement clarification, product design, B-side ops pages, architecture governance, development, testing, integration, and release gates into one reusable workflow — so agents keep making correct calls in complex business contexts.",
    language: "Shell",
    languageColor: "#89e051",
    stars: 12,
    repo: "https://github.com/BiuBiuHu/opc-skills",
    homepage: OPC_SKILLS_SITE,
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
  }
];

export const projects = await hydrateProjectStars(projectList);

export function getFeaturedProjects(limit = 3) {
  return projects.filter((p) => p.featured).slice(0, limit);
}

export function statusLabel(status) {
  return status === "wip" ? "In progress" : "Maintained";
}
