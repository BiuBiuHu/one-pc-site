// 删除文章（GitHub Contents API DELETE 需要文件 sha）
// POST /api/delete {password,slug,sha} → { ok }
export function createHandler(env) {
  const OWNER = env.GH_OWNER || "BiuBiuHu";
  const REPO = env.GH_REPO || "one-pc-site";
  const BRANCH = env.GH_BRANCH || "main";
  const TOKEN = env.GH_TOKEN;
  const PASSWORD = env.WRITE_PASSWORD;
  const API = "https://api.github.com";

  return async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") return res.status(405).json({ ok: false });
    if (!PASSWORD || !TOKEN) return res.status(503).json({ ok: false, message: "写作服务暂不可用" });

    const { password, slug, sha } = req.body || {};
    if (password !== PASSWORD) return res.status(401).json({ ok: false, message: "口令错误" });
    if (!slug || !sha) return res.status(400).json({ ok: false, message: "缺少 slug 或 sha" });

    if (!/^[\p{L}\p{N}][\p{L}\p{N}_-]{0,199}$/u.test(slug)) return res.status(400).json({ ok: false, message: "无效 slug" });
    const path = `src/content/blog/${slug}.md`;
    const r = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(path)}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "one-pc-site",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ message: `delete: ${slug}`, sha, branch: BRANCH })
    });

    if (!r.ok) {
      const detail = await r.text();
      return res.status(500).json({ ok: false, message: "删除失败", detail });
    }
    return res.status(200).json({ ok: true });
  }

}

// Vercel remains available for rollback; the Worker passes its own env bindings.
export default function handler(req, res) { return createHandler(process.env)(req, res); }
