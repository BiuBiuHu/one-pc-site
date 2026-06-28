// 自托管评论：用 GitHub Contents API 把评论存到仓库 comments.json
// GET  /api/comments?slug=xxx  → 返回该文章评论
// POST /api/comments {slug,name,body} → 追加一条评论
const OWNER = "BiuBiuHu";
const REPO = "one-pc-site";
const FILE = "comments.json";
const BRANCH = "main";
const TOKEN = process.env.GH_TOKEN;
const API = "https://api.github.com";

const authHeaders = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "one-pc-site"
};

async function readStore() {
  // 仓库公开：读取走 raw（不消耗 token 额度），拿 sha 走 API
  let data = {};
  try {
    const raw = await fetch(
      `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${FILE}`,
      { cache: "no-store" }
    );
    if (raw.ok) data = JSON.parse(await raw.text());
  } catch {}
  let sha = null;
  try {
    const meta = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${FILE}`, { headers: authHeaders });
    if (meta.ok) sha = (await meta.json()).sha;
  } catch {}
  return { data, sha };
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
  return r.ok;
}

export default async function handler(req, res) {
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

    const { data, sha } = await readStore();
    const list = data[slug] || [];
    list.push({ name: safeName, body: safeBody, time: Date.now() });
    data[slug] = list;
    const ok = await writeStore(data, sha);
    if (!ok) return res.status(500).json({ ok: false, message: "写入失败，稍后再试" });
    return res.status(200).json({ ok: true, comments: list });
  }

  res.status(405).json({ ok: false });
}
