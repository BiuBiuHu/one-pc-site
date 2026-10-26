import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

function parseIsoDate(value) {
  if (!value) return null;
  const d = new Date(String(value).trim().replace(/^["']|["']$/g, ""));
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm = m[1];
  const get = (key) => {
    const hit = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return hit ? hit[1].trim() : undefined;
  };
  return {
    date: parseIsoDate(get("date")),
    updated: parseIsoDate(get("updated")),
    lang: (get("lang") || "zh").replace(/^["']|["']$/g, ""),
    draft: /^true$/i.test(get("draft") || "")
  };
}

function gitLastmod(relPath) {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%cI", "--", relPath], {
      cwd: ROOT,
      encoding: "utf8"
    }).trim();
    return parseIsoDate(out);
  } catch {
    return null;
  }
}

function later(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function pathKey(pathname) {
  return pathname.replace(/\/+$/, "") || "/";
}

function collectBlogDates() {
  const map = new Map();
  const blogDir = join(ROOT, "src/content/blog");
  let latest = null;
  let latestZh = null;
  let latestEn = null;

  if (!existsSync(blogDir)) return { map, latest, latestZh, latestEn };

  for (const name of readdirSync(blogDir)) {
    if (!name.endsWith(".md")) continue;
    const fm = parseFrontmatter(readFileSync(join(blogDir, name), "utf8"));
    if (fm.draft || !fm.date) continue;
    const last = later(fm.date, fm.updated);
    const slug = name.replace(/\.md$/, "").replace(/-en$/, "");
    const urlPath = fm.lang === "en" ? `/en/blog/${slug}` : `/blog/${slug}`;
    map.set(urlPath, last);
    latest = later(latest, last);
    if (fm.lang === "en") latestEn = later(latestEn, last);
    else latestZh = later(latestZh, last);
  }

  return { map, latest, latestZh, latestEn };
}

function buildLastmodLookup() {
  const { map, latest, latestZh, latestEn } = collectBlogDates();

  const staticPages = [
    ["/", "src/pages/index.astro", latest],
    ["/en", "src/pages/en/index.astro", latest],
    ["/about", "src/pages/about.astro"],
    ["/en/about", "src/pages/en/about.astro"],
    ["/projects", "src/pages/projects.astro"],
    ["/en/projects", "src/pages/en/projects.astro"],
    ["/projects/opc-skills", "src/pages/projects/opc-skills.astro"],
    ["/en/projects/opc-skills", "src/pages/en/projects/opc-skills.astro"],
    ["/services", "src/pages/services.astro"],
    ["/en/services", "src/pages/en/services.astro"],
    ["/blog", "src/pages/blog/index.astro", latestZh],
    ["/en/blog", "src/pages/en/blog/index.astro", latestEn]
  ];

  for (const [path, file, contentDate] of staticPages) {
    const date = later(gitLastmod(file), contentDate);
    if (date) map.set(path, date);
  }

  return { map, fallback: latest || new Date() };
}

const lookup = buildLastmodLookup();

/** ISO lastmod for a sitemap URL: post frontmatter, else page/content date, else latest post. */
export function lastmodForUrl(url) {
  let pathname = "/";
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = String(url);
  }
  return (lookup.map.get(pathKey(pathname)) || lookup.fallback).toISOString();
}
