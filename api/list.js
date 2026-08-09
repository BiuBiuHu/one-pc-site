// 列出所有文章的元信息（用于「我的文章」抽屉）
// GET /api/list?password=xxx → { ok, items:[{slug,title,date,excerpt,category,sha}] }
const OWNER = "BiuBiuHu";
const REPO = "one-pc-site";
const BRANCH = "main";
const TOKEN = process.env.GH_TOKEN;
const PASSWORD = process.env.WRITE_PASSWORD;
const API = "https://api.github.com";

const authHeaders = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "one-pc-site"
};

function parseMeta(text) {
  var m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return {};
  var meta = {};
  m[1].split(/\r?\n/).forEach(function (line) {
    var mm = line.match(/^(\w+):\s*(.*)$/);
    if (mm) meta[mm[1]] = mm[2].trim();
  });
  return meta;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false });

  const password = req.query.password || "";
  if (password !== PASSWORD) return res.status(401).json({ ok: false, message: "口令错误" });

  // 列目录（带 token，避免匿名限额）；每个文件元素自带 sha
  const r = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/src/content/blog`, {
    headers: authHeaders
  });
  if (!r.ok) return res.status(500).json({ ok: false, message: "读取列表失败" });
  const files = await r.json();
  const mds = Array.isArray(files) ? files.filter((f) => f.name.endsWith(".md")) : [];

  // 并行拉每篇 frontmatter（raw 不消耗 token 额度）
  const items = await Promise.all(
    mds.map(async (f) => {
      const slug = f.name.replace(/\.md$/, "");
      try {
        const raw = await fetch(
          `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/src/content/blog/${encodeURIComponent(f.name)}`,
          { cache: "no-store" }
        );
        const text = raw.ok ? await raw.text() : "";
        const meta = parseMeta(text);
        return {
          slug,
          title: meta.title || slug,
          date: meta.date || "",
          excerpt: meta.excerpt || "",
          category: meta.category || "思考",
          sha: f.sha || ""
        };
      } catch (e) {
        return { slug, title: slug, date: "", excerpt: "", category: "思考", sha: f.sha || "" };
      }
    })
  );

  // 按 date 倒序
  items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return res.status(200).json({ ok: true, items });
}
