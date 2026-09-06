// 博客封面图生成脚本（gpt-image-2 via Apistation）
// 用法：node scripts/gen-cover.mjs "文章标题" "主题关键词" [输出文件名]
//   例：node scripts/gen-cover.mjs "LLM Agent 出口校验" "AI 安全 / 幻觉"
// 安全：key 绝不硬编码——优先读环境变量 APISTATION_API_KEY，否则从 dida-ai-service/.env 读取（该文件已 gitignore）
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BLOG_ROOT = resolve(__dirname, "..");

// --- 1. 读 key ---
function loadEnvFile(path) {
  const map = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) map[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return map;
}

// 默认从 dida-ai-service 的 .env 读（可用环境变量 APISTATION_ENV 覆盖路径）
const ENV_PATH =
  process.env.APISTATION_ENV || "/Users/ysh/code/ai/didi-operator/dida-ai-service/.env";

const env = process.env.APISTATION_API_KEY
  ? { ...process.env }
  : existsSync(ENV_PATH)
    ? { ...loadEnvFile(ENV_PATH), ...process.env }
    : process.env;

const apiKey = env.APISTATION_API_KEY;
if (!apiKey) {
  console.error("❌ 未找到 APISTATION_API_KEY。请设环境变量或确认 .env 路径：" + ENV_PATH);
  process.exit(1);
}
const baseUrl = (env.APISTATION_BASE_URL || "https://apistation.cn/v1").replace(/\/$/, "");
const model = env.APISTATION_IMAGE_MODEL || "gpt-image-2-client";

// --- 2. 参数 ---
const title = process.argv[2];
const theme = process.argv[3] || title;
if (!title) {
  console.error("用法：node scripts/gen-cover.mjs \"文章标题\" \"主题关键词\" [输出文件名]");
  process.exit(1);
}
// 文件名只用英文/数字（避免中文文件名在 URL 里被 percent-encode）
const slug = (title + "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 40);
const outName = process.argv[4] || (slug ? `${slug}.png` : null);
if (!outName) {
  console.error("⚠️ 标题是纯中文，无法自动生成英文文件名，请传第 3 个参数指定：");
  console.error('  node scripts/gen-cover.mjs "标题" "主题" "英文文件名.png"');
  process.exit(1);
}

// --- 3. 生成封面 prompt ---
const prompt = `为下面这篇中文技术博客生成一张简洁、专业、现代的封面插图。
文章标题：${title}
主题：${theme}

风格硬性要求：
- 浅色背景（接近白色或极浅灰），干净、现代、专业，有科技感但不花哨
- 扁平或轻微渐变，避免复杂纹理和噪点
- 用抽象视觉隐喻表达主题（如 AI/Agent/架构 → 齿轮、节点连线、电路、光路；安全 → 盾牌、锁、校验）
- 构图 16:9 横版，主体居中或偏左，右侧留白
- 绝对不要出现任何文字、字母、数字、水印（避免 AI 生成乱码文字）
- 配色清爽，可用青绿 #4ECDC4 或靛蓝 #4F46E5 作为点缀色`;

// --- 4. 调用 API ---
async function main() {
  console.log(`🎨 生成封面：${title}`);
  console.log(`   模型：${model} | 尺寸：1536x1024`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 240_000);

  try {
    const res = await fetch(`${baseUrl}/images/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        prompt,
        n: 1,
        size: "1536x1024",
        output_format: "png",
        response_format: "b64_json",
      }),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      console.error(`❌ 生图失败 ${res.status}：${text.slice(0, 300)}`);
      process.exit(1);
    }
    const data = JSON.parse(text);
    const first = Array.isArray(data?.data) ? data.data[0] : data;
    const b64 = first?.b64_json || first?.base64 || first?.image_base64;
    if (!b64) {
      console.error("❌ 响应里没有图片数据");
      process.exit(1);
    }

    const outDir = join(BLOG_ROOT, "public", "images");
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, outName);
    writeFileSync(outPath, Buffer.from(b64, "base64"));
    console.log(`✅ 已保存：public/images/${outName}`);
    console.log(`   在 frontmatter 里加：ogImage: /images/${outName}`);
  } catch (e) {
    console.error(`❌ 出错：${e?.message || e}`);
    process.exit(1);
  } finally {
    clearTimeout(timer);
  }
}

main();
