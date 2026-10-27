export const LOCALES = ["zh", "en", "ja"];

export const HREFLANG = {
  zh: "zh-CN",
  en: "en-US",
  ja: "ja-JP"
};

export const HTML_LANG = {
  zh: "zh-CN",
  en: "en",
  ja: "ja"
};

export const DATE_LOCALE = {
  zh: "zh-CN",
  en: "en-US",
  ja: "ja-JP"
};

export const LOCALE_LABEL = {
  zh: "中文",
  en: "English",
  ja: "日本語"
};

export function normalizeLocale(lang) {
  return lang === "en" || lang === "ja" ? lang : "zh";
}

export function postSlug(id) {
  return String(id).replace(/-(en|ja)$/, "");
}

export function localePrefix(lang) {
  const locale = normalizeLocale(lang);
  if (locale === "en") return "/en";
  if (locale === "ja") return "/ja";
  return "";
}

export function blogHref(lang, slug = "") {
  const prefix = localePrefix(lang);
  return slug ? `${prefix}/blog/${slug}/` : `${prefix}/blog/`;
}

export function homeHref(lang) {
  const prefix = localePrefix(lang);
  return prefix ? `${prefix}/` : "/";
}

export function localeOf(post) {
  return normalizeLocale(post?.data?.lang);
}

export function inLanguageOf(lang) {
  return HREFLANG[normalizeLocale(lang)];
}
