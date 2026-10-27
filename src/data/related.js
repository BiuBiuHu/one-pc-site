// 文末相关阅读：按系列 / 分类挑少量文章，主题对上时再挂一条项目。

import { hubPathForProject } from "./product-hubs.js";
import { normalizeLocale, postSlug } from "../lib/i18n.js";

const PROJECTS = {
  anpai: {
    zh: {
      name: "Anpai.Life",
      href: "https://www.anpai.life/",
      note: "任务 + 日历 + AI 规划"
    },
    en: {
      name: "Anpai.Life",
      href: "https://www.anpai.life/",
      note: "Task + calendar + AI planning"
    },
    ja: {
      name: "Anpai.Life",
      href: "https://www.anpai.life/",
      note: "タスク + カレンダー + AIプランニング"
    }
  },
  "opc-skills": {
    zh: {
      name: "OPC Skills",
      href: hubPathForProject("OPC Skills", false),
      note: "一人产品的研发流水线 Skill"
    },
    en: {
      name: "OPC Skills",
      href: hubPathForProject("OPC Skills", true),
      note: "Delivery-pipeline Skill for one-person products"
    },
    ja: {
      name: "OPC Skills",
      href: hubPathForProject("OPC Skills", "ja"),
      note: "一人プロダクト向けの納品パイプライン Skill"
    }
  },
  gateway: {
    zh: {
      name: "AI Gateway",
      href: "https://apistation.cn/",
      note: "多模型中转与成本治理"
    },
    en: {
      name: "AI Gateway",
      href: "https://apistation.cn/",
      note: "Unified multi-model gateway"
    },
    ja: {
      name: "AI Gateway",
      href: "https://apistation.cn/",
      note: "マルチモデル中継とコスト管理"
    }
  }
};

const SLUG_PROJECT = {
  "todo-app-sync-01": "anpai",
  "anpai-vs-ticktick-free": "anpai",
  "ai-gateway-01": "gateway",
  "opc-software-practice": "anpai",
  "loop-engineering": "opc-skills"
};

const SERIES_PROJECT = {
  意图识别: "anpai"
};

function localeOf(post) {
  return post.data.lang ?? "zh";
}

function byDateDesc(a, b) {
  return b.data.date.getTime() - a.data.date.getTime();
}

function take(list, picked, seen, limit) {
  for (const p of list) {
    if (picked.length >= limit) break;
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    picked.push(p);
  }
}

export function pickRelatedPosts(allPosts, current, { lang, limit = 3, skipSeries = false } = {}) {
  const locale = normalizeLocale(lang);
  const pool = allPosts
    .filter((p) => localeOf(p) === locale && !p.data.draft && p.id !== current.id)
    .sort(byDateDesc);

  const picked = [];
  const seen = new Set();
  const series = current.data.series;
  const category = current.data.category;

  if (series && !skipSeries) {
    take(
      pool.filter((p) => p.data.series === series),
      picked,
      seen,
      limit
    );
  }

  if (category) {
    take(
      pool.filter((p) => p.data.category === category && (!skipSeries || p.data.series !== series)),
      picked,
      seen,
      limit
    );
  }

  take(pool, picked, seen, limit);
  return picked;
}

export function pickRelatedProject(post, lang) {
  const locale = normalizeLocale(lang);
  const slug = postSlug(post.id);
  const hay = [post.id, post.data.title, post.data.excerpt, post.data.series, post.data.category]
    .filter(Boolean)
    .join("\n");

  let key = SLUG_PROJECT[slug] || (post.data.series && SERIES_PROJECT[post.data.series]);

  if (!key) {
    if (/opc-skills|loop engineering|skills\s*\+|垂直场景/i.test(hay)) key = "opc-skills";
    else if (/anpai|安排日历|清单应用|todo app/i.test(hay)) key = "anpai";
    else if (/ai gateway|ai 中转|中转站|apistation/i.test(hay)) key = "gateway";
    else if (/\bopc\b|一人.*产品|one person can/i.test(hay)) key = "opc-skills";
  }

  const project = key ? PROJECTS[key] : null;
  return project ? project[locale] : null;
}
