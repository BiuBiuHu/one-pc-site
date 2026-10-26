// 构建期拉取 GitHub stargazers_count。失败时退回数据文件里的占位，不编造数字。
const cache = new Map();

export function githubRepoSlug(repoUrl = "") {
  if (!String(repoUrl).includes("github.com")) return "";
  return String(repoUrl)
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
}

async function requestStargazersCount(repoFull) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "one-pc-site"
  };
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`https://api.github.com/repos/${repoFull}`, {
      headers,
      signal: controller.signal
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.stargazers_count === "number" ? data.stargazers_count : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchStargazersCount(repoFull, fallback) {
  if (!repoFull) return fallback;
  if (!cache.has(repoFull)) {
    cache.set(repoFull, requestStargazersCount(repoFull));
  }
  const count = await cache.get(repoFull);
  return count == null ? fallback : count;
}

export async function hydrateProjectStars(projects) {
  return Promise.all(
    projects.map(async (project) => {
      const slug = githubRepoSlug(project.repo);
      if (!slug) return project;
      const stars = await fetchStargazersCount(slug, project.stars);
      return { ...project, stars };
    })
  );
}
