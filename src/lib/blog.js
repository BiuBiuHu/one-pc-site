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
  "Agent 开发": "agent-development",
  "Agent Development": "agent-development",
  意图识别: "agent-development",
  "WebView 与客户端": "webview-and-native",
  "WebView & Native": "webview-and-native"
};

/** Course modules for series pages that are a curriculum, not a date-sorted list. */
export const SERIES_CURRICULUM = {
  "agent-development": [
    {
      id: "intent-control",
      title: { zh: "意图识别与控制系统", en: "Intent & Control" },
      orders: [1, 2, 3]
    },
    {
      id: "slots-practice",
      title: { zh: "槽位、实践与出口校验", en: "Slots, Practice & Exit Validation" },
      orders: [4, 5, 6]
    },
    {
      id: "memory-retrieval",
      title: { zh: "记忆与检索", en: "Memory & Retrieval" },
      orders: [7, 8]
    },
    {
      id: "tools-protocols",
      title: { zh: "工具与协议", en: "Tools & Protocols" },
      orders: [9, 10, 11]
    },
    {
      id: "multi-agent",
      title: { zh: "多 Agent 编排", en: "Multi-Agent Orchestration" },
      orders: [12]
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
      title: { zh: "认知与架构", en: "Cognition & Architecture" },
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
  "agent-development": { zh: "Agent 开发", en: "Agent Development" },
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
  "agent-development": {
    zh: "从意图识别与控制系统出发，经过槽位、出口校验、记忆检索，再到 MCP / A2A 与多 Agent 编排。一条可落地的 Agent 工程路径。",
    en: "Start with intent and control, then slots, exit validation, memory and retrieval, MCP/A2A, and multi-agent orchestration. A practical Agent engineering path."
  },
  "full-stack-engineering": {
    zh: "从前端视角进入 Java 与 Spring：语言与框架、工程协作、一致性与并发、性能与缓存、规模与领域建模。",
    en: "Java and Spring from a frontend vantage: language and framework, collaboration, consistency and concurrency, performance, and domain modeling."
  },
  "webview-and-native": {
    zh: "从「把 WebView 当容器/浏览器」讲清内核、进程、桥、双网络栈、缓存、安全与排障。一条写给前端的客户端容器路径。",
    en: "From treating WebView as just a browser to kernel, process model, JSBridge, dual network stacks, cache, security, and incident response. A container path for frontend engineers. Chinese course; English translation is not available yet."
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

/** Curriculum series in catalog order. Includes empty locale shells so EN can show a Chinese-only course. */
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

const ZH_LESSON = [
  "",
  "第一课",
  "第二课",
  "第三课",
  "第四课",
  "第五课",
  "第六课",
  "第七课",
  "第八课",
  "第九课",
  "第十课",
  "第十一课",
  "第十二课"
];

/** UI label for a course slot. Empty when the series is not a curriculum. Never mutates titles. */
export function seriesLessonLabel(name, order, lang = "zh") {
  if (!seriesCurriculum(name) || order == null) return "";
  const n = Number(order);
  if (!Number.isFinite(n) || n < 1) return "";
  if (lang === "en") return `Lesson ${n}`;
  return ZH_LESSON[n] || `第${n}课`;
}

/** Group series posts into course modules by seriesOrder. Never sorts by date. */
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
