import { localePrefix } from "./i18n.js";

const SERIES_ORDER_FALLBACK = Number.MAX_SAFE_INTEGER;

export const ZH_CATEGORY_ORDER = ["后端", "AI 工程提效", "Agent 开发", "WebView 与客户端", "思考", "好文共读", "玩转流量"];
export const EN_CATEGORY_ORDER = ["Engineering", "Agent Development", "WebView & Native", "Thoughts", "Traffic & Growth"];

/** Stable slugs so ZH/EN counterparts of the same column share a URL segment. */
const SERIES_SLUGS = {
  全栈工程: "full-stack-engineering",
  "Full-Stack Engineering": "full-stack-engineering",
  前端转全栈: "full-stack-engineering",
  "Frontend to Full-Stack": "full-stack-engineering",
  "Agent 实战": "agent-development",
  "Agent in Practice": "agent-development",
  "Agent 开发": "agent-development",
  "Agent Development": "agent-development",
  意图识别: "agent-development",
  "从零手搓 AI Agent": "build-an-agent-from-scratch",
  "《从零手搓 AI Agent》": "build-an-agent-from-scratch",
  "Build an Agent from Scratch": "build-an-agent-from-scratch",
  "WebView 与客户端": "webview-and-native",
  "WebView & Native": "webview-and-native"
};

/** Thematic groups for series pages that follow a reading order, not a date-sorted list. */
export const SERIES_CURRICULUM = {
  "build-an-agent-from-scratch": [
    {
      id: "foundations",
      title: { zh: "卷一 · 打地基：Agent 基础四件套", en: "Volume 1 · Foundations" },
      orders: [1, 2, 3, 4, 5]
    },
    {
      id: "demystify",
      title: { zh: "卷二 · 去魔法：手写底层实现", en: "Volume 2 · Write the stack by hand" },
      orders: [6, 7, 8]
    },
    {
      id: "engineering",
      title: { zh: "卷三 · 工程化：从玩具到产品", en: "Volume 3 · From toy to product" },
      orders: [9, 10, 11, 12, 13, 14, 15, 16, 17]
    },
    {
      id: "advanced-sdk",
      title: { zh: "卷四 · 进阶能力与 SDK 源码精读", en: "Volume 4 · Advanced skills & SDK" },
      orders: [18, 19, 20, 21, 22, 23]
    },
    {
      id: "async-enterprise",
      title: { zh: "卷五 · 异步架构与企业级升级", en: "Volume 5 · Async & enterprise" },
      orders: [24, 25, 26, 27, 28, 29]
    },
    {
      id: "production-quality",
      title: { zh: "卷六 · 生产级质量保障", en: "Volume 6 · Production quality" },
      orders: [30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40]
    },
    {
      id: "ai-coding",
      title: { zh: "卷七 · AI Coding 新范式", en: "Volume 7 · AI coding harness" },
      orders: [41, 42, 43]
    },
    {
      id: "interop",
      title: { zh: "卷八 · Agent 互操作协议", en: "Volume 8 · Interop protocols" },
      orders: [44, 45, 46, 47, 48]
    },
    {
      id: "appendix",
      title: { zh: "附录 · Agent 架构七题", en: "Appendix · Seven architecture cards" },
      orders: [49, 50, 51, 52, 53, 54, 55]
    }
  ],
  "agent-development": [
    {
      id: "intent-control",
      title: { zh: "意图识别与控制系统", en: "Intent & Control" },
      orders: [1, 2, 3]
    },
    {
      id: "slots-practice",
      title: { zh: "槽位、实践与出口校验", en: "Slots, Practice & Exit Validation" },
      orders: [4, 5, 6, 7]
    },
    {
      id: "memory-retrieval",
      title: { zh: "记忆、检索与会话压缩", en: "Memory, Retrieval & Compaction" },
      orders: [8, 9, 10]
    },
    {
      id: "tools-protocols",
      title: { zh: "工具、协议与生产化", en: "Tools, Protocols & Production" },
      orders: [11, 12, 13, 14, 15, 16]
    },
    {
      id: "multi-agent",
      title: { zh: "多 Agent 编排", en: "Multi-Agent Orchestration" },
      orders: [17, 18]
    }
  ],
  "full-stack-engineering": [
    {
      id: "language-framework",
      title: { zh: "语言与框架基础", en: "Language & Framework" },
      orders: [1, 2, 3, 4]
    },
    {
      id: "engineering-practice",
      title: { zh: "工程协作", en: "Engineering Practice" },
      orders: [5]
    },
    {
      id: "consistency",
      title: { zh: "一致性与并发", en: "Consistency & Concurrency" },
      orders: [6, 7, 8]
    },
    {
      id: "performance",
      title: { zh: "性能与缓存", en: "Performance & Caching" },
      orders: [9, 10]
    },
    {
      id: "scale-domain",
      title: { zh: "规模与领域建模", en: "Scale & Domain Modeling" },
      orders: [11, 12]
    }
  ],
  "webview-and-native": [
    {
      id: "cognition-architecture",
      title: { zh: "从差异到原理", en: "From differences to the model" },
      orders: [1, 2]
    },
    {
      id: "dual-webview",
      title: { zh: "双端 WebView", en: "Native WebViews" },
      orders: [3, 4]
    },
    {
      id: "bridge-storage-network",
      title: { zh: "桥、存储与网络", en: "Bridge, Storage & Network" },
      orders: [5, 6, 7]
    },
    {
      id: "offline-perf-security",
      title: { zh: "离线包、性能与安全", en: "Offline Pack, Performance & Security" },
      orders: [8, 9, 10]
    },
    {
      id: "debug-frontier",
      title: { zh: "排障与前沿", en: "Debugging & Frontiers" },
      orders: [11, 12]
    }
  ]
};

const SERIES_NAMES = {
  "build-an-agent-from-scratch": { zh: "从零手搓 AI Agent", en: "Build an Agent from Scratch" },
  "agent-development": { zh: "Agent 实战", en: "Agent in Practice" },
  "full-stack-engineering": { zh: "全栈工程", en: "Full-Stack Engineering" },
  "webview-and-native": { zh: "WebView 与客户端", en: "WebView & Native" }
};

export function sortCategoryKeys(keys, preferred = []) {
  return [...keys].sort((a, b) => {
    const ia = preferred.indexOf(a);
    const ib = preferred.indexOf(b);
    if (ia === -1 && ib === -1) return String(a).localeCompare(String(b), "zh");
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

/** Preferred labels first (even if empty), then any extra categories that have posts. */
export function listArchiveCategories(groups, preferred = []) {
  const keys = new Set(preferred);
  for (const key of groups.keys()) keys.add(key);
  return sortCategoryKeys(keys, preferred);
}

export function compareSeriesPosts(a, b) {
  const ao = a.data.seriesOrder ?? SERIES_ORDER_FALLBACK;
  const bo = b.data.seriesOrder ?? SERIES_ORDER_FALLBACK;
  if (ao !== bo) return ao - bo;
  return a.data.date.getTime() - b.data.date.getTime();
}

export function seriesSlug(name) {
  if (!name) return "";
  if (SERIES_SLUGS[name]) return SERIES_SLUGS[name];
  const ascii = String(name)
    .trim()
    .toLowerCase()
    .replace(/['’"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii || "series";
}

export function seriesHref(lang, name) {
  const slug = seriesSlug(name);
  const prefix = localePrefix(lang === "en" ? "en" : "zh");
  return slug ? `${prefix}/blog/series/${slug}/` : `${prefix}/blog/`;
}

export function seriesIndexHref(lang) {
  const prefix = localePrefix(lang === "en" ? "en" : "zh");
  return `${prefix}/series/`;
}

const SERIES_COPY = {
  "build-an-agent-from-scratch": {
    zh: "从一次 API 调用开始，到企业级 Agent 系统：多轮对话、手写底层、工程化、异步架构、生产级质量，再到互操作协议。开篇词加 54 篇，八卷加附录，边写代码边学。",
    en: "From a single API call to a production-grade Agent system: conversation, hand-written internals, engineering, async architecture, production quality, and interop protocols. An opening essay plus 54 lessons. Published in Chinese; English versions are not available yet."
  },
  "agent-development": {
    zh: "从意图识别与控制系统出发，经过槽位与出口校验、记忆检索与会话压缩，再到 MCP / A2A、生产化与多 Agent 编排。一条可落地的 Agent 工程路径。",
    en: "Start with intent and control, then slots, exit validation, memory, retrieval and conversation compaction, then MCP/A2A, productionization, and multi-agent orchestration. A practical Agent engineering path."
  },
  "full-stack-engineering": {
    zh: "从前端视角进入 Java 与 Spring：语言与框架、工程协作、一致性与并发、性能与缓存、规模与领域建模。",
    en: "Java and Spring from a frontend vantage: language and framework, collaboration, consistency and concurrency, performance, and domain modeling."
  },
  "webview-and-native": {
    zh: "这是写给前端同学的课，帮你掌握客户端相关的知识。页面跑在 App 里时，登录丢失、桥调不通、白屏，往往不是 H5 写错了，而是容器在起作用。",
    en: "A course for frontend engineers who need to understand the native side. When your page runs inside an App, a lost login, a silent JSBridge, or a white screen often comes from the container, not from your H5."
  }
};

export function seriesCopy(name, lang = "zh") {
  const copy = SERIES_COPY[seriesSlug(name)];
  if (!copy) return "";
  return copy[lang === "en" ? "en" : "zh"] || copy.zh;
}

export function isCurriculumSeries(name) {
  return Boolean(SERIES_CURRICULUM[seriesSlug(name)]);
}

/** Curriculum series in catalog order. Includes empty locale shells so EN can show a Chinese-only column. */
export function collectCurriculumSeries(posts, lang = "zh") {
  const locale = lang === "en" ? "en" : "zh";
  const bySlug = new Map(collectSeries(posts, { min: 1 }).map((s) => [s.slug, s]));
  return Object.keys(SERIES_CURRICULUM).map((slug) => {
    const found = bySlug.get(slug);
    if (found) return found;
    return {
      name: SERIES_NAMES[slug][locale],
      slug,
      count: 0,
      first: null,
      posts: []
    };
  });
}

export function seriesCurriculum(name) {
  return SERIES_CURRICULUM[seriesSlug(name)] || null;
}

export function seriesCurriculumSlots(name) {
  const modules = seriesCurriculum(name);
  if (!modules) return 0;
  return Math.max(...modules.flatMap((m) => m.orders));
}

const ZH_ARTICLE = [
  "",
  "第一篇",
  "第二篇",
  "第三篇",
  "第四篇",
  "第五篇",
  "第六篇",
  "第七篇",
  "第八篇",
  "第九篇",
  "第十篇",
  "第十一篇",
  "第十二篇",
  "第十三篇",
  "第十四篇",
  "第十五篇",
  "第十六篇",
  "第十七篇",
  "第十八篇"
];

/** UI label for a column slot. Empty when the series is not a curriculum. Never mutates titles. */
export function seriesArticleLabel(name, order, lang = "zh") {
  if (!seriesCurriculum(name) || order == null) return "";
  const n = Number(order);
  if (!Number.isFinite(n) || n < 1) return "";
  if (lang === "en") return `Article ${n}`;
  return ZH_ARTICLE[n] || `第${n}篇`;
}

/** Group series posts into thematic modules by seriesOrder. Never sorts by date. */
export function groupSeriesCurriculum(posts, name, lang = "zh") {
  const modules = seriesCurriculum(name);
  if (!modules) return null;
  const byOrder = new Map();
  for (const post of posts) {
    const order = post.data.seriesOrder;
    if (order == null || byOrder.has(order)) continue;
    byOrder.set(order, post);
  }
  const locale = lang === "en" ? "en" : "zh";
  return modules.map((mod, index) => ({
    id: mod.id,
    index: index + 1,
    title: mod.title[locale] || mod.title.zh,
    orders: mod.orders,
    posts: mod.orders.map((order) => byOrder.get(order)).filter(Boolean)
  }));
}

/** Series in the given collection. Default min=2 for archive strips. */
export function collectSeries(posts, { min = 2 } = {}) {
  const groups = new Map();
  for (const post of posts) {
    const name = post.data.series;
    if (!name) continue;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(post);
  }
  const bySlug = new Map();
  for (const [name, list] of groups) {
    if (list.length < min) continue;
    const sorted = [...list].sort(compareSeriesPosts);
    const slug = seriesSlug(name);
    if (bySlug.has(slug)) continue;
    bySlug.set(slug, { name, slug, count: sorted.length, first: sorted[0], posts: sorted });
  }
  return [...bySlug.values()].sort((a, b) => compareSeriesPosts(a.first, b.first));
}
