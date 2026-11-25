import { normalizeLocale } from "./i18n.js";

/** Resolve a project's official site: string homepage, or a zh/en/ja map. */
export function projectHomepageHref(project, lang) {
  const homepage = project?.homepage;
  if (!homepage) return "";
  if (typeof homepage === "string") return homepage;
  const locale = normalizeLocale(lang);
  return homepage[locale] || homepage.en || homepage.zh || "";
}
