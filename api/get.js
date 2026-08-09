// 读取单篇文章（含 sha，编辑后更新要用）
// GET /api/get?slug=xxx&password=yyy → { ok, slug, sha, title, date, excerpt, category, body }
const OWNER = "BiuBiuHu";
const REPO = "one-pc-site";
const TOKEN = process.env.GH_TOKEN;
const PASSWORD = process.env.WRITE_PASSWORD;
const API = "https://api.github.com";

const authHeaders = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "one-pc-site"
};

function parsePost(text) {
  var m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  var meta = {};
  m[1].split(/\r?\n/).forEach(function (line) {
    var mm = line.match(/^(\w+):\s*(.*)$/);
    if (mm) meta[mm[1]] = mm[2].trim();
  });
  return { meta: meta, body: m[2] };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false });

  const slug = (req.query.slug || "").trim();
  const password = req.query.password || "";
  if (password !== PASSWORD) return res.status(401).json({ ok: false, message: "口令错误" });
  if (!slug) return res.status(400).json({ ok: false, message: "缺少 slug" });

  const path = `src/content/blog/${slug}.md`;
  const r = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(path)}`, {
    headers: authHeaders
  });
  if (!r.ok) return res.status(404).json({ ok: false, message: "文章不存在" });
  const data = await r.json();
  const text = Buffer.from(data.content, "base64").toString("utf8");
  const { meta, body } = parsePost(text);
  return res.status(200).json({
    ok: true,
    slug,
    sha: data.sha,
    title: meta.title || slug,
    date: meta.date || "",
    excerpt: meta.excerpt || "",
    category: meta.category || "思考",
    body: body.replace(/^\n+|\n+$/g, "")
  });
}
