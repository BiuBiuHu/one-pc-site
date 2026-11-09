import { localePrefix } from "./i18n.js";

const SERIES_ORDER_FALLBACK = Number.MAX_SAFE_INTEGER;

export const ZH_CATEGORY_ORDER = ["后端", "AI 工程提效", "AI", "思考", "好文共读", "玩转流量"];
export const EN_CATEGORY_ORDER = ["Engineering", "AI", "Thoughts", "Traffic & Growth"];

/** Stable slugs so ZH/EN counterparts of the same column share a URL segment. */
const SERIES_SLUGS = {
  前端转全栈: "frontend-to-full-stack",
  "Frontend to Full-Stack": "frontend-to-full-stack",
  "Agent 开发": "agent-development",
  "Agent Development": "agent-development",
  意图识别: "agent-development"
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
