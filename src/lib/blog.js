const SERIES_ORDER_FALLBACK = Number.MAX_SAFE_INTEGER;

export const ZH_CATEGORY_ORDER = ["后端", "工程", "AI", "思考", "好文共读"];
export const EN_CATEGORY_ORDER = ["Engineering", "AI", "Thoughts"];

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

export function compareSeriesPosts(a, b) {
  const ao = a.data.seriesOrder ?? SERIES_ORDER_FALLBACK;
  const bo = b.data.seriesOrder ?? SERIES_ORDER_FALLBACK;
  if (ao !== bo) return ao - bo;
  return a.data.date.getTime() - b.data.date.getTime();
}

/** Series with ≥2 posts in the given collection, each linking to the first post. */
export function collectSeries(posts) {
  const groups = new Map();
  for (const post of posts) {
    const name = post.data.series;
    if (!name) continue;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(post);
  }
  return [...groups.entries()]
    .filter(([, list]) => list.length >= 2)
    .map(([name, list]) => {
      const sorted = [...list].sort(compareSeriesPosts);
      return { name, count: sorted.length, first: sorted[0] };
    })
    .sort((a, b) => compareSeriesPosts(a.first, b.first));
}
