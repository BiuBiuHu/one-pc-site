import { Buffer } from "node:buffer";
// 自托管评论：用 GitHub Contents API 把评论存到仓库 comments.json
// GET  /api/comments?slug=xxx  → 返回该文章评论
// POST /api/comments {slug,name,body} → 追加一条评论
export function createHandler(env) {
  const OWNER = env.GH_OWNER || "BiuBiuHu";
  const REPO = env.GH_REPO || "one-pc-site";
  const FILE = "comments.json";
  const BRANCH = env.GH_BRANCH || "main";
  const TOKEN = env.GH_TOKEN;
  const API = "https://api.github.com";

  const authHeaders = {
    Authorization: `Bearer ${TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "one-pc-site"
  };

  async function readStore() {
    // Read content and SHA atomically; raw GitHub caches can lag behind a new SHA.
    const response = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${FILE}?ref=${encodeURIComponent(BRANCH)}`, { headers: authHeaders });
    if (response.status === 404) return { data: {}, sha: null };
    if (!response.ok) throw new Error("读取评论失败");
    const snapshot = await response.json();
    return { data: JSON.parse(Buffer.from(snapshot.content, "base64").toString("utf8")), sha: snapshot.sha };
  }

  async function writeStore(data, sha) {
    const content = Buffer.from(JSON.stringify(data, null, 2)).toString("base64");
    const body = { message: "chore: update comments", content, branch: BRANCH };
    if (sha) body.sha = sha;
    const r = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${FILE}`, {
      method: "PUT",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return r.status;
  }

  return async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") return res.status(204).end();

    if (req.method === "GET") {
      const slug = req.query.slug || "";
      const { data } = await readStore();
      const list = data[slug] || [];
      return res.status(200).json({ ok: true, comments: list });
    }

    if (req.method === "POST") {
      if (!TOKEN) return res.status(500).json({ ok: false, message: "GH_TOKEN 未配置" });
      const { slug, name, body } = req.body || {};
      if (!slug || !body) return res.status(400).json({ ok: false, message: "缺少 slug 或正文" });
      const safeName = String(name || "匿名").trim().slice(0, 40) || "匿名";
      const safeBody = String(body).trim().slice(0, 2000);
      if (!safeBody) return res.status(400).json({ ok: false, message: "正文为空" });

      const entry = { name: safeName, body: safeBody, time: Date.now() };
      for (let attempt = 0; attempt < 3; attempt++) {
        const { data, sha } = await readStore();
        const list = data[slug] || [];
        list.push(entry);
        data[slug] = list;
        const status = await writeStore(data, sha);
        if (status >= 200 && status < 300) return res.status(200).json({ ok: true, comments: list });
        if (status !== 409 && status !== 422) break;
      }
      return res.status(503).json({ ok: false, message: "写入失败，稍后再试" });
    }

    res.status(405).json({ ok: false });
  }

}

// Vercel remains available for rollback; the Worker passes its own env bindings.
export default function handler(req, res) { return createHandler(process.env)(req, res); }
