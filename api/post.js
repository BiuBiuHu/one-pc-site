// 写作后台：口令校验后，把新文章提交到 src/content/blog/
// POST /api/post {password,title,excerpt,body}
const OWNER = "BiuBiuHu";
const REPO = "one-pc-site";
const BRANCH = "main";
const TOKEN = process.env.GH_TOKEN;
const PASSWORD = process.env.WRITE_PASSWORD;
const API = "https://api.github.com";

function slugify(s) {
  return String(s)
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/[^\w一-龥-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false });

  const { password, title, excerpt, category, body } = req.body || {};
  if (password !== PASSWORD) return res.status(401).json({ ok: false, message: "口令错误" });
  if (!title || !body) return res.status(400).json({ ok: false, message: "缺少标题或正文" });

  const stamp = new Date().toISOString().slice(0, 10);
  const slug = (slugify(title) || "post") + "-" + Date.now().toString(36);
  const fm = [
    "---",
    `title: ${String(title).replace(/\n/g, " ")}`,
    `date: ${stamp}`,
    excerpt ? `excerpt: ${String(excerpt).replace(/\n/g, " ")}` : null,
    category ? `category: ${String(category).replace(/\n/g, " ").trim()}` : null,
    "---",
    "",
    String(body),
    ""
  ]
    .filter((x) => x !== null)
    .join("\n");

  const content = Buffer.from(fm).toString("base64");
  const path = `src/content/blog/${slug}.md`;
  const r = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(path)}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "one-pc-site",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ message: `post: ${title}`, content, branch: BRANCH })
  });

  if (!r.ok) {
    const detail = await r.text();
    return res.status(500).json({ ok: false, message: "发布失败", detail });
  }
  return res.status(200).json({ ok: true, slug, url: `/blog/${slug}` });
}
