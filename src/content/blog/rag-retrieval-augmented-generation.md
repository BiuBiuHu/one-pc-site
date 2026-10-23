---
title: RAG — 检索增强生成
date: 2026-10-23
excerpt: RAG 让 Agent 能回答私有知识库里的问题；这篇从切片、Embedding、向量库讲到混合 BM25+向量+RRF、精排、OpenSearch，以及私人 RAG 的 ACL / Permissions Collapse。
category: AI
---

> 目标：让 Agent 能回答私有知识库里的问题，而不仅仅依赖模型训练时的知识。

---

## 背景：LLM 的知识边界

LLM 的知识来自训练数据，有两个硬限制：

1. **时效性**：训练数据有截止日期，不知道最新发生的事
2. **私有性**：不知道你公司内部的文档、代码库、产品手册

**RAG（Retrieval-Augmented Generation，检索增强生成）** 解决这两个问题：

```
传统方式：用户问题 → LLM（只有训练知识）→ 回答
RAG 方式：用户问题 → 检索相关文档 → 把文档塞进 Prompt → LLM → 回答
```

同一条 Agent 能力链上：RAG 管「读知识」，[MCP](/blog/mv99u875/) 管「用工具」（[双角色实践](/blog/mv99wysd/)），[A2A](/blog/a2a-agent-to-agent/) 管「和其他 Agent 协作」。三者互补。

---

## 核心原理：向量相似度检索

### 为什么用向量？

文本不能直接比较相似度，但可以把文本转成**向量（Embedding）**——一个高维数字数组，语义相近的文本，向量距离也近。

```
"如何重置密码" → [0.12, -0.34, 0.89, ...]  ← 1536 维向量
"密码找回方法" → [0.11, -0.35, 0.87, ...]  ← 距离很近，语义相似
"今天天气如何" → [0.78, 0.23, -0.45, ...]  ← 距离很远，语义不同
```

### RAG 的三个阶段

```
【离线阶段：建立知识库】
文档 → 切片（Chunking）→ 向量化（Embedding）→ 存入向量数据库

【在线阶段：检索 + 生成】
用户问题 → 向量化 → 在向量数据库中找最近邻 → 取出相关文档片段
         → 拼入 Prompt → LLM 生成回答
```

---

## 实现：从零搭建一个简单 RAG

### 第一步：文档切片（Chunking）

```typescript
// 把长文档切成小块，每块约 500 字符
// 切片时保留一定重叠（overlap），防止关键信息被切断
function chunkText(text: string, chunkSize = 500, overlap = 50): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));
    start += chunkSize - overlap; // 每次前进 (chunkSize - overlap)，保留重叠
  }

  return chunks;
}
```

### 第二步：向量化（Embedding）

```typescript
import { embed, embedMany } from 'ai';
import { openai } from '@ai-sdk/openai';

const embeddingModel = openai.embedding('text-embedding-3-small');

// 批量向量化文档片段
async function embedChunks(chunks: string[]): Promise<number[][]> {
  const { embeddings } = await embedMany({
    model: embeddingModel,
    values: chunks,
  });
  return embeddings; // 每个 chunk 对应一个向量
}

// 向量化用户问题
async function embedQuery(query: string): Promise<number[]> {
  const { embedding } = await embed({
    model: embeddingModel,
    value: query,
  });
  return embedding;
}
```

### 第三步：向量存储与检索

```typescript
// 简单的内存向量数据库（生产环境用 Chroma、Pinecone、pgvector）
interface VectorDocument {
  id: string;
  content: string;
  embedding: number[];
  metadata?: Record<string, string>;
}

class SimpleVectorStore {
  private documents: VectorDocument[] = [];

  // 添加文档
  add(doc: VectorDocument): void {
    this.documents.push(doc);
  }

  // 余弦相似度：衡量两个向量的方向相似程度，值域 [-1, 1]，越接近 1 越相似
  private cosineSimilarity(vectorA: number[], vectorB: number[]): number {
    const dotProduct = vectorA.reduce((sum, a, i) => sum + a * vectorB[i], 0);
    const magnitudeA = Math.sqrt(vectorA.reduce((sum, a) => sum + a * a, 0));
    const magnitudeB = Math.sqrt(vectorB.reduce((sum, b) => sum + b * b, 0));
    return dotProduct / (magnitudeA * magnitudeB);
  }

  // 检索最相似的 topK 个文档
  search(queryEmbedding: number[], topK = 3): VectorDocument[] {
    return this.documents
      .map(doc => ({
        doc,
        score: this.cosineSimilarity(queryEmbedding, doc.embedding),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ doc }) => doc);
  }
}
```

### 第四步：RAG 完整流程

```typescript
// 把 RAG 封装成一个工具，让 Agent 能主动调用
const ragSearchTool = tool({
  description: '在知识库中搜索相关文档，回答用户关于产品、文档的问题',
  parameters: z.object({
    query: z.string().describe('搜索关键词或问题'),
    topK: z.number().default(3).describe('返回最相关的文档数量'),
  }),
  execute: async ({ query, topK }) => {
    // 1. 向量化用户问题
    const queryEmbedding = await embedQuery(query);

    // 2. 检索最相关的文档片段
    const relevantDocs = vectorStore.search(queryEmbedding, topK);

    // 3. 返回文档内容（Agent 会把这些内容注入 Prompt）
    return {
      documents: relevantDocs.map(doc => ({
        content: doc.content,
        source: doc.metadata?.source ?? '未知来源',
      })),
      message: `找到 ${relevantDocs.length} 条相关文档`,
    };
  },
});
```

---

## 离线建库：索引文档

```typescript
// 一次性脚本：把文档库向量化并存入向量数据库
async function buildIndex(documents: { content: string; source: string }[]) {
  for (const doc of documents) {
    // 1. 切片
    const chunks = chunkText(doc.content);

    // 2. 批量向量化
    const embeddings = await embedChunks(chunks);

    // 3. 存入向量数据库
    chunks.forEach((chunk, i) => {
      vectorStore.add({
        id: `${doc.source}-${i}`,
        content: chunk,
        embedding: embeddings[i],
        metadata: { source: doc.source },
      });
    });

    console.log(`✅ 已索引: ${doc.source}（${chunks.length} 个片段）`);
  }
}

// 使用示例
await buildIndex([
  { content: fs.readFileSync('docs/product-manual.md', 'utf-8'), source: 'product-manual' },
  { content: fs.readFileSync('docs/faq.md', 'utf-8'), source: 'faq' },
  { content: fs.readFileSync('docs/api-reference.md', 'utf-8'), source: 'api-reference' },
]);
```

---

## RAG 的常见优化

| 问题 | 优化方案 |
|------|----------|
| **切片太短**，上下文不完整 | 增大 chunkSize，或使用语义切片（按段落/标题切） |
| **切片太长**，噪音太多 | 减小 chunkSize，增大 topK 后再重排序 |
| **检索不准** | 使用 HyDE（先让 LLM 生成假设答案，再用假设答案检索） |
| **结果重复** | MMR（最大边际相关性）算法，在相似度和多样性之间取平衡 |
| **生产环境** | 用 Chroma、Pinecone、pgvector 替代内存存储，支持持久化和水平扩展 |

---

## 检索链路全景：多路召回 → RRF 融合 → 精排 → 证据过滤与生成

> 把上面「重排 / BM25」散落的机制收拢成一条**可跑的完整链路**。核心主张：
> **RAG 的答案质量取决于证据质量，证据质量取决于检索链路的分层设计。**

### 为什么不能只用一种检索

- 向量检索擅长**语义**（「怎么申请年假」→ 能命中「员工休假管理制度」），但对精确词、专有名词、版本号、错误码、API 参数、条款编号等**字面锚点**不敏感，「意思像、细节不对」。
- BM25 **认字面**（`temperature=0`、`ERR_5001`、`v2.3.1 升级说明` 这类靠词法最稳），但不懂语义，换个说法就捞不到。
- 二者**正交**，不是替代关系：**向量管「意思像不像」，BM25 管「词有没有出现」**。

### 元数据过滤：第三路，管「范围对不对」

向量/BM25 都是**打分**；元数据过滤是**硬条件**（布尔匹配，不打分）——入库时给每个 chunk 打结构化标签
（`source / version / updated_at / dept / authority / tenant_id / doc_type / status`），
查询时先用布尔条件把范围画出来：

```json
{
  "query": { "match": { "content": "年假 申请 流程" } },
  "filter": {
    "bool": { "must": [
      { "term": { "version": "v2" } },
      { "term": { "status": "active" } },
      { "term": { "authority": "hr" } }
    ]}
  }
}
```

**关键：Pre-filter（先筛后搜），不要 Post-filter（搜完再删）**

- ✅ Pre-filter：先按标签缩小候选空间，**在合法子集内**算相似度/做召回——正确且提速。
- ❌ Post-filter：先召回 Top-K 再删——Top-K 会被**旧版/无权文档占满**，删完有效上下文被抽空
  （与「ACL 下推」一节的三个致命问题同原理）。
- ES 里对应 `filter context`（不打分、可缓存），别拿 `post_filter` 当主过滤。

它同时是三件事的技术载体：**10★「召回旧版」的解法**、**ACL 下推的实现**、多路召回中「范围对不对」的那一路。

### 四步链路

| 阶段 | 作用 | 关键目标 |
|------|------|---------|
| ① 多路召回 | 向量检索 + BM25 + 元数据过滤 | **不漏**关键证据（高召回） |
| ② 结果融合 | RRF 等排名融合 | **统一**不同检索器输出（可比较） |
| ③ 精排 | Cross-Encoder 重排 | **挑准** Top-k（高精确） |
| ④ 证据过滤 + 生成 | 阈值过滤 + LLM 回答 | 减少幻觉、可解释 |

```
query ─► ①多路召回(向量+BM25+元数据) ─► ②RRF融合 ─► ③精排(top-k) ─► ④阈值过滤+LLM
```

- **① 高召回**：把可能相关的都捞进来，宁可多、不可漏（向量换说法 + BM25 兜字面 + 元数据缩范围）。
- **② 结果融合：RRF（先分清，RRF ≠ 重排）**
  RRF 是「**合并排名**」，Cross-Encoder 重排是「**重新打分**」，两回事、两个阶段：

  | | RRF（融合） | Cross-Encoder 重排 |
  |---|---|---|
  | 阶段 | 召回之后、精排之前 | 精排阶段 |
  | 输入 | 多路召回的排名榜 | 融合后的候选列表 |
  | 做什么 | 把不同检索器的排名合并成一个统一排序 | 对 Query + Document 联合精细打分 |
  | 成本 | 很低，纯数学 | 较高，要跑模型 |

  RRF 基于「**排名位置**」，不看原始分数：

  ```
  RRF(d) = Σ_i  1 / (k + rank_i(d))     # d=文档；rank_i(d)=它在第 i 路的排名；k 常取 60；某路没召回就不计
  ```

  例：文档 A 在向量路排第 2、在 BM25 路排第 1、在图谱路没出现 → `1/(k+2) + 1/(k+1)`；
  B 只在向量路排第 3 → 只有一项贡献，融合后通常排在 A 后。
  **为什么用排名不用分数**：各路量纲不同——向量相似度 0.87/0.92、BM25 分数 5.3/12.7、
  图谱命中路径数/关系权重，直接相加没意义、归一化又麻烦；RRF 把「排第几」转成可比贡献，天然统一。
  打个比方：召回=两网撒下去各捞一批鱼；RRF=把两网倒一起按「哪网排得靠前」先排个序；重排=逐条仔细挑，把真最相关的挑到最前。
  正因为 RRF 轻快（纯数学）、重排重（跑模型），才「先 RRF 合并、再重排精挑」配合用。
- **③ 精排**：用 Cross-Encoder 对融合后的候选（如 Top-20~50）重新精细打分，只留 top-k 进 Prompt（细节见「重排」小节）。
- **④ 过滤**：最高分都不够 → 知识库可能没可靠答案，**谨慎答/拒答**；否则只拿 Top-3~5 作证据。

### 可跑骨架（向量 + BM25 + RRF，TS）

> 在文档前文 `SimpleVectorStore`（纯内存向量库）基础上扩展：建库时同时建一份 BM25 词频倒排，检索时双路召回再用 RRF 融合。

```typescript
import { embed, embedMany } from 'ai';
import { openai } from '@ai-sdk/openai';

const embeddingModel = openai.embedding('text-embedding-3-small');

// 向量检索库（沿用前文 SimpleVectorStore，这里只取它「按相似度排名的 id 列表」）
interface VecLike { search(emb: number[], topN: number): { id: string }[] }

// ---------- ① 建库：双路索引 ----------
type Doc = { id: string; content: string; metadata: Record<string, string> };

// 建库脚本里同时填充向量库与 BM25，并维护 id -> Doc 映射
function buildIndexes(chunks: Doc[], vec: VecLike, bm25: SimpleBM25Index) {
  const docsById = new Map(chunks.map((c) => [c.id, c]));
  for (const c of chunks) bm25.add(c);
  // ... 向量部分：embedMany(chunks[i].content) 后 vec.add({id, embedding})（见前文 embedChunks）
  return docsById;
}

// 简易 BM25：分词 + 记录每词在哪些 doc、出现几次
function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
}

class SimpleBM25Index {
  private df = new Map<string, number>();
  private tf = new Map<string, Map<string, number>>();
  private docs: Doc[] = [];

  add(doc: Doc): void {
    this.docs.push(doc);
    const counts = new Map<string, number>();
    for (const w of tokenize(doc.content)) counts.set(w, (counts.get(w) ?? 0) + 1);
    for (const [w, n] of counts) {
      this.tf.set(doc.id, (this.tf.get(doc.id) ?? new Map()).set(w, n));
      this.df.set(w, (this.df.get(w) ?? 0) + 1);
    }
  }

  search(query: string, topK: number): { id: string; score: number }[] {
    const k1 = 1.2, N = this.docs.length;
    const qws = tokenize(query);
    const scoreOf = (docId: string) => {
      let s = 0;
      const tf = this.tf.get(docId)!;
      for (const q of qws) {
        const f = tf.get(q) ?? 0;
        if (!f) continue;
        const idf = Math.log((N - (this.df.get(q) ?? 0) + 0.5) / ((this.df.get(q) ?? 0) + 0.5) + 1);
        s += idf * ((f * (k1 + 1)) / (f + k1));
      }
      return s;
    };
    return this.docs
      .map((d) => ({ id: d.id, score: scoreOf(d.id) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}

function rrf(
  rankedLists: { id: string }[][],
  k = 60,
): { id: string; score: number }[] {
  const acc = new Map<string, number>();
  for (const list of rankedLists) {
    for (let i = 0; i < list.length; i++) {
      acc.set(list[i].id, (acc.get(list[i].id) ?? 0) + 1 / (k + i + 1));
    }
  }
  return [...acc.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

class RetrievalChain {
  constructor(
    private vector: VecLike,
    private bm25: SimpleBM25Index,
    private byId: (id: string) => Doc,
  ) {}

  async recall(query: string, topN: number) {
    const qEmb = await embed({ model: embeddingModel, value: query });
    const vecHits = this.vector.search(qEmb.embedding, topN).map((d) => ({ id: d.id }));
    const bmHits = this.bm25.search(query, topN);
    return rrf([vecHits, bmHits]);
  }

  filter(ids: { id: string; score: number }[], minScore: number, topK: number): string[] {
    if (ids.length === 0 || ids[0].score < minScore) return [];
    return ids.slice(0, topK).map((r) => this.byId(r.id).id);
  }
}

const ragAskTool = tool({
  description: '在知识库中检索并回答：多路召回(BM25+向量)+RRF融合+证据过滤',
  parameters: z.object({ query: z.string(), topN: z.number().default(20), topK: z.number().default(3) }),
  execute: async ({ query, topN, topK }) => {
    const fused = await chain.recall(query, topN);
    const best = chain.filter(fused, /*minScore*/ 0.4, topK);
    const docs = best.map((id) => chain.byId(id));
    return {
      hit: docs.length > 0,
      message: docs.length ? `找到 ${docs.length} 条证据` : '未找到足够相关的证据，建议拒答',
      documents: docs.map((d) => ({ content: d.content, source: d.metadata.source })),
    };
  },
});
```

### 实际落地建议（渐进式）

1. **先做**：向量检索 + 重排——成本低、提升立竿见影。
2. **再加**：当库里出现大量专业术语 / 产品编号 / API 文档 / 政策条款时，补 **BM25 + RRF 融合**。
3. 成熟系统再要求模型**引用来源 / 标注片段**；证据不足时明确说「未找到相关信息」，谨慎优于瞎编。

> 一句话总结：**RAG 的答案质量取决于证据质量，证据质量取决于检索链路的分层设计。**

---

## 检索优化：重排（Rerank）

**Rerank 是 RAG 里的精排层**：召回阶段负责「别漏掉」，Rerank 负责「别把错的送进大模型」。

```
query ─► 粗召回(top-50) ─► 重排(top-50→top-5) ─► 注入 Prompt
         向量相似度/BM25       cross-encoder/LLM
         快、高召回、低精度      精、高精度
```

- **第一段要「快 + 别漏」**：向量/BM25 一次捞出 50~100 个候选（优先考虑召回率）。
- **第二段要「准」**：对候选重打分，只留最相关的 top-k 进 Prompt（提高精确率）。因为只在「短候选」上跑昂贵模型，整体代价可控。

### 它解决什么问题（召回回来的四类噪音）

向量检索和 BM25 召回的候选里，通常混着这些噪音：

- **语义接近，但答非所问**；
- **关键词命中，但上下文不匹配**；
- **年份、产品名、编号、权限、版本不对**；
- 多个 chunk 都在说同一件事，但**只有一个是真正可用的**。

Rerank 把这几十到上百个候选重新打分，把真正最相关的排到前面，截断成 **Top-3 / Top-5** 交给 LLM。

### 机制核心：Bi-encoder vs Cross-encoder（为什么 Rerank 更准）

| | Bi-encoder（粗召回用） | Cross-encoder（重排用） |
|---|---|---|
| 编码 | 问题和片段**各自独立**编码成向量 | `(问题, 片段)` 拼成一个输入、一起过模型 |
| token 交互 | 编码时 Q、P **互不看到对方** | Q、P 的 token **互相 attend**，捕捉细粒度关系 |
| 打分 | 余弦相似度 | 模型直接输出相关性分数 |
| 可预计算 | ✅ 片段向量离线算好 → 快 | ❌ 每对现场跑 → 慢 |
| 精度 | 中（「整体语义」相近） | 高（「这段真答到点上」） |

> 人话：粗召回像「看你俩简历分开看像不像」；重排像「把你俩拉一起面试，看对话对不对得上」。

所以：
- **向量检索看的是「两个向量像不像」**；
- **Rerank 看的是「这个文档是否真的回答了这个问题」**。

例：用户问「2026 年假期安排」，向量检索可能把 2024、2025 的假期文档也召回（语义相近）；
Rerank 更容易把**年份不匹配**的文档压下去。

### 典型链路（全链路位置）

```text
用户 Query
   ↓
向量检索 + BM25 召回 Top-50 ~ Top-100
   ↓
RRF 融合成统一排名        ← RRF 是「融合多路召回」
   ↓
Rerank 对候选精排          ← Rerank 是「对融合后的候选做精细打分」
   ↓
过滤低分文档，取 Top-3 ~ Top-5
   ↓
交给 LLM 生成答案
```

### 主流 Rerank 模型

| 类型 | 代表模型 | 特点 |
|---|---|---|
| Cross-Encoder | BGE-Reranker-v2-m3、Qwen3-Reranker | 精度高，中文/多语言效果好 |
| Listwise | Jina Reranker v3.5、mxbai-rerank-v3 | 一次看多个候选，排序更一致 |
| 延迟交互 | ColBERT | 比 Cross-Encoder 快，适合大规模库 |
| LLM 重排 | RankLLM、Qwen3 | 理解强，但成本高，适合小候选集 |

### 工程上怎么选

- **中文 RAG、私有化部署**：优先 **BGE-Reranker-v2-m3**。
- **长文档、复杂推理**：可选 **Qwen3-Reranker-4B/8B**。
- **低延迟、大规模召回**：**ColBERT** 或轻量 Listwise 模型。
- **快速验证**：直接接 Cohere、Jina、SiliconFlow 等 Rerank API。

### 三种具体做法

1. **Cross-encoder 模型**：闭源 **Cohere Rerank**（生产常用）；开源 **BGE-reranker**、`cross-encoder/ms-marco-MiniLM` 等。输入 `(query, 候选数组)`，输出每个候选一个分数。
2. **LLM 当重排器**：把候选塞进「请按相关性排序」的 prompt，让 LLM 打分/排序。适合领域词多、通用 reranker 不认识的场景；代价是又欠一次 LLM 调用。
3. **顺带澄清**：BM25 + 向量的 RRF 融合常被归到「重排」名下，但严格说它是**上一阶段（融合）**——解决「双路合并」；重排解决「精筛」。两者配合用（见「检索链路全景」）。

### 和「改写（query rewrite）」的分工

在这条职责链里——

- **改写（query rewrite / HyDE）在召回【前】**：把问题改成「更好检索」的形式，提升**召回率**（捞得全）。
- **重排（rerank）在召回【后】**：在候选里精筛，提升**精确率**（留得准）。
- 一个管「捞得全」、一个管「留得准」，是两个环节，别混为一谈。

### 一个关键原则：先保证召回，再上 Rerank

Rerank 只能「从好候选里挑最好的」，**不能把完全没召回到的东西变出来**。如果 Recall@50 很低，
说明粗召回已经漏掉了关键证据，这时候加 Rerank 提升有限。更稳的升级顺序是：

```
分块策略 → 混合检索 → RRF 融合 → Rerank → 阈值过滤 → LLM 生成
```

### Rerank 接入代码骨架（BGE-Reranker 精排 + 截断 Top-5）

接在前面 `RetrievalChain` 的 RRF 融合之后：**融合拿到 Top-N 候选 → 交给 Rerank 精排 → 阈值过滤 → 取 Top-5 喂给 LLM**。

```typescript
async function rerank(query: string, docs: Doc[], topK: number): Promise<RerankResult[]> {
  const res = await fetch('https://api.siliconflow.cn/v1/rerank', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.RERANK_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'BAAI/bge-reranker-v2-m3',
      query,
      documents: docs.map((d) => d.content),
      top_n: topK,
      return_documents: false,
    }),
  });
  const data: { results: { index: number; relevance_score: number }[] } = await res.json();
  return data.results.map((r) => ({ id: docs[r.index].id, relevance: r.relevance_score }));
}

class RetrievalChain {
  async ask(
    query: string,
    opts: { topN: number; rerankK: number; finalK: number; minRelevance: number },
  ): Promise<{ hit: boolean; documents: Doc[] }> {
    const fused = await this.recall(query, opts.topN);
    if (fused.length === 0) return { hit: false, documents: [] };

    const candidates = fused.map((r) => this.byId(r.id));
    const ranked = await rerank(query, candidates, opts.rerankK);

    const best = ranked.filter((r) => r.relevance >= opts.minRelevance);
    if (best.length === 0) return { hit: false, documents: [] };

    return {
      hit: true,
      documents: best.slice(0, opts.finalK).map((r) => this.byId(r.id)),
    };
  }
}

const { hit, documents } = await chain.ask(query, {
  topN: 20,
  rerankK: 5,
  finalK: 5,
  minRelevance: 0.3,
});

if (!hit) {
  console.log('知识库中没有找到足够相关的资料');
} else {
  const context = documents.map((d, i) => `[${i + 1}] ${d.content}`).join('\n\n');
  // generateText({ prompt: `仅根据以下资料回答，并标注引用编号：\n${context}\n\n问题：${query}` })
}
```

**三个要点**：
1. **两级截断**：`topN=20`（融合后粗留）→ `rerankK=5`（精排后细留），先宽后窄。
2. **分数语义换了**：RRF 分数只用于排序，**阈值过滤要用 rerank 的 `relevance_score`**——它才是「这个文档是否真回答了问题」的度量。
3. **拒答优于瞎编**：`minRelevance` 过滤 + 空结果走「未找到相关信息」分支，让证据不足可见。

---

## 词法检索：BM25（与向量互补）

重排/召回里常出现的 **BM25（Best Matching 25）** 是「词法（关键词）相关度打分」的经典算法，
也是 **Lucene / Elasticsearch / OpenSearch** 默认的召回排序。它是 TF-IDF 的进阶，核心公式（简化）：

```
score(D,Q) = Σ 对每个查询词 q：
   IDF(稀有度) × 词频项(带饱和) × 长度归一化
   - IDF        ：出现在越少文档越稀有 → 贡献越大
   - 词频项     ：出现越多分越高，但会【饱和】(k1≈1.2 压住堆砌)
   - 长度归一化 ：长文档打折，避免「因为长而占便宜」(b≈0.75)
```

- **词频饱和**：同词出现 3 次 vs 100 次，相关度差别没那么大，`k1` 压关键词作弊。
- **长度归一化**：长文顺带含某词 ≠ 很相关，`b` 打掉系统偏差。
- **稀有词加权**：精专术语（`password_reset_timeout`）比泛词（`the`）贡献大。

**与 Embedding/向量 互补**：

| | BM25（词法） | Embedding（语义） |
|---|---|---|
| 匹配依据 | **精确词面出现** | 语义相近（换说法也中） |
| 擅长 | 精确术语、ID、专有名词 | 说人话、同义改写 |
| 短板 | 换个说法就捞不到 | 精确关键词/陌生专名会漏 |
| 成本 | 快、无模型 | 需要 embedding + 向量库 |

> BM25 认「字面」，向量认「意思」。生产 RAG 常用 **hybrid：BM25 + 向量双路召回 → RRF 融合**，
> 让向量把「换说法」捞回来、BM25 把「精确术语/ID」兜住，两者互补进重排。

### BM25 存储要求（建索引时的 Checklist）

**核心前提**：BM25 分数是**查询时现算的**（依赖查询词），存储要备齐「计算材料」——
这点和 embedding 相反（embedding 离线预算好，查询时算余弦；BM25 分数每次查询都不同，**不能预存**）。

**必备四件套**：

| 要存的东西 | 用途 |
|-----------|------|
| **倒排表**：term → (chunk_id, tf) | 查询词命中谁、命中几次 |
| **df**：每个词出现在多少个 chunk | 算 IDF（稀有词加权） |
| **字段长度**：每个 chunk 词数 + 全库均值 avgdl | 长度归一化（`b` 参数） |
| **分词结果 / analyzer 配置** | 词怎么切、小写化、词干化 |

（骨架 `SimpleBM25Index` 的 `df`/`tf` 两张 Map 就是极简版；ES/Lucene 由引擎自动维护。）

**六个硬要求**：

1. **分词一致**：索引期和查询期必须是**同一套 analyzer**（不一致 = 词对不上 = 查不到）；中文用 IK/HanLP/smartcn 插件；升级分词器 = **全量重建** BM25 索引。
2. **字段类型对**：内容用 `text`（可分析、建倒排），ID/编号等精确匹配另开 `keyword` 子字段，别混。
3. **norms 不能关**：它存的就是「字段长度」，关了长度归一化就废了。
4. **粒度 = 一个 chunk 一个 BM25 doc**：chunk 太长会失真（被长度归一化压低）且噪多，太短则命中碎片化（呼应 8★ 对照实验）；标题等强信号可拆字段加权。
5. **增删同步统计量**：`df`、`avgdl` 随文档增删变化；ES 里删除的 doc 在 segment merge 前仍占统计；**源文档更新必须重建该 chunk 的词法索引**（呼应 10★ 索引同步）。
6. **两条线共用 chunk_id**：`id → embedding`（向量库）与 `id → (term, tf, 长度)`（BM25）一一对应，RRF 才能按 id 合并。

> 一句话：**存 BM25 = 存「倒排 + df + 长度统计 + 分词配置」；分数本身不存（也存不了），只在这堆材料上由查询现算。**

---

## 真实业务：OpenSearch 混合检索怎么做

> 手写骨架（BM25 倒排 + `rrf()` 融合 + 元数据过滤）在生产里的对照物是 **OpenSearch 的「一个 doc 三合一 + 一发 hybrid query + 一个 RRF pipeline」**——大部分手写逻辑由服务端替你完成。

### 1. mapping：一个 doc 三合一（文本 / 向量 / 元数据）

```json
{
  "mappings": {
    "properties": {
      "content":       { "type": "text",   "analyzer": "standard" },
      "content_embed": { "type": "dense_vector", "dims": 1024,
                         "index": true, "similarity": "cosine" },
      "chunk_id":      { "type": "keyword" },
      "version":       { "type": "keyword" },
      "authority":     { "type": "keyword" },
      "source":        { "type": "keyword" }
    }
  }
}
```

写索引时，同一份 chunk 的 `content`（文本）+ `content_embed`（embedding）+ 元数据一起进一条 doc。
ES 会**自动**给 `text` 字段建 BM25 倒排（不用手动「加一列」），`dense_vector` 字段建向量索引。

### 2. 一发 hybrid query：同时跑 BM25 + kNN

```json
POST /kb/_search?search_pipeline=kb_rrf&size=50
{
  "_source": ["chunk_id", "content", "source", "version"],
  "query": {
    "bool": {
      "filter": [
        { "term": { "version": "v2" } },
        { "term": { "authority": "hr-2026" } }
      ],
      "must": [{
        "hybrid": {
          "queries": [
            { "match": { "content": "员工休假管理制度" } },
            { "knn": { "content_embed": { "vector": [/*...*/], "k": 50 } } }
          ]
        }
      }]
    }
  }
}
```

> 别用 `post_filter` 做主过滤——它发生在召回/聚合之后，等于「Top-K 被占满再删」（见「元数据过滤：Pre-filter vs Post-filter」）。

### 3. RRF 融合：search pipeline 的 normalization 处理器

```json
PUT /_search/pipeline/kb_rrf
{
  "response_processors": [{
    "normalization-processor": {
      "normalization_technique": "rrf",
      "combination": { "parameters": { "k": 60 } }
    }
  }]
}
```

### 4. 中文分词：analyzer 是关键（真实业务坑位）

`standard` analyzer 对中文按「整段/逐字」分，召回粗糙——生产一般装 **IK / HanLP / smartcn** 分词插件，
把 analyzer 设成 `ik_smart` / `ik_max_word`，让 `员工休假管理制度` 切成 `员工|休假|管理|制度`。
这就是上一节正则 `[a-z0-9_]` 在中文失效的生产解法。

### 5. 重排接在哪

召回(50~100) + 融合由 OpenSearch 返回；**精排仍自己接**：把 top-N 喂给 Cohere Rerank / 自建
cross-encoder，或挂 OpenSearch 的 neural search 文本重排 pipeline——对应骨架里「融合后 topN→topK」那一步。

### 对照表：手写骨架 vs OpenSearch

| 手写骨架 | OpenSearch |
|---|---|
| 自己写 inverted index + `rrf()` | `text` 字段自动 BM25 + `hybrid query` + normalization(RRF) 处理器 |
| 自己维护 df/tf Map | 服务端倒排 + 统计全管 |
| 元数据过滤手写 | `post_filter` / `filter` 一条匹配搞定 |
| 中文分词裸正则失效 | 配 `ik_smart` / `smartcn` 等分词插件 |
| cross-encoder 自己外接 | 外部 rerank，或 neural search pipeline |

一句话：**真实业务用 OpenSearch，是「一个 doc 三合一 + 一发 hybrid query + 一个 RRF pipeline」顶掉骨架里所有手写逻辑；你真正要做的只剩切块、embedding、和融合后再接一个 cross-encoder 精排。**

---

## 进阶：长文档建库 / 效果诊断 / 溯源（面试向）

### 8★ 长文档怎么建库、chunk 怎么定

- **按结构切**：优先按标题/段落/表格/条款等「语义边界」切，而不是死板固定长度——语义完整的一块，向量化效果明显更好。
- **元数据带版本/权限**：每个 chunk 要有 `version`、`source`、`authority` 等元数据，否则做不了失效过滤、溯源、权限裁剪。
- **overlap 防切断**：语义边界处的关键信息可能被一刀切开，保留一小段重叠（overlap）避免丢失。
- **chunk 大小用对照实验**：别凭感觉编「500 token」这种数字；固定其他变量，扫不同 `chunk_size`（加 rerank 兜底）看召回/精确的实测曲线再定。

### 9★ 效果不好从哪几层优化

把优化拆成**责任链**，每层各管一个环节、各有可独立验证的开销：

```
解析 → 切块 → 改写(query rewrite) → 召回(retrieval) → 重排(rerank) → 生成
```

| 层 | 管什么 | 怎么验证 |
|----|--------|---------|
| 解析 | 把 PDF/Word 变成干净文本（OCR、版面还原） | 看原文是否被正确抽出来 |
| 切块 | chunk 语义是否完整 | 随机抽 chunk 读一下完整性 |
| 改写 | 查询是否捞得到正确答案 | 单独测「改写前 vs 后」的召回 |
| 召回 | 是否拿到候选 | 看 top-50 里有没有正解 |
| 重排 | 精筛是否把正解顶到 top-k | 看 top-5 里有没有正解 |
| 生成 | 给对材料是否答得对 | 单测生成质量 |

**主根因取最早那步**：解析/切块这种源头错了，后面再怎么调召回/重排都白费——排查要自上而下，先看最先出问题的那一层。

### 10★ 库里有正解却召回旧版

先别急着怪「相似度」。「**搜得对**」的前提是「**库本身对**」——

1. **查版本元数据**：是不是有几版文件并存，chunk 带了旧 `version`，检索时没有按版本过滤 → 优先过滤到**最新版**。
2. **失效过滤**：下架/过期文档是否仍在索引里？有没有活跃状态标记与定时同步。
3. **索引同步**：源文档更新后，向量库有没有增量重建？旧 chunk 是否残留。
4. 以上都排除了，才回到相似度本身：chunk 太大太散、词面差异、embedding 域不匹配等。

> 一句话：**「召回旧版」十有八九是数据/索引问题，不是检索算法问题。**

---

## 安全：私人 RAG 的 ACL 必须下推到检索层

> **结论先行**：私人 RAG 必须把 ACL 下推到检索层，不能只在召回后做业务过滤；脱敏也不能替代 ACL。

### Permissions Collapse：企业 RAG 不是「公开搜索引擎」

同一个知识库里会同时存在：全员可见制度、部门内部文档、管理层经营数据、
财务/人事/合同/客户资料、项目级/租户级/密级不同的内容。

如果检索不做权限隔离，用户只要用自然语言提问，就可能把**本来无权访问的文档片段召回进上下文**。
模型一旦看到这些内容，就可能通过总结、改写、推理**间接泄露**。

这就是 **Permissions Collapse（权限坍塌）**：源系统里本来有细粒度权限，但文档进入向量索引后
权限元数据丢失，**所有能查库的人都能语义命中全部文档**。

### 为什么「召回后再过滤」不行（三个致命问题）

**1. 越权数据已经进入候选集**
召回阶段已经把无权文档加载进内存、进入候选池，甚至可能进入 Rerank、Prompt 拼接、Trace 日志。
过滤只是「最后藏起来」，**泄露窗口已经打开**。

**2. Top-K 会被无权文档占满**
假设 Top-K=5，召回里有 4 条无权 + 1 条有权。后滤删掉 4 条，只剩 1 条可用——表面是「过滤掉了」，
实质是**有效上下文被抽空**，召回质量直接崩塌。

**3. Trace、缓存、日志会泄漏**
召回原文、打分、Prompt、Rerank 输入输出常被写进 LangSmith / Langfuse / SIEM / 自建日志。
ACL 不在检索层生效，这些链路里就可能留下**无权文档片段**。

### ACL 应该下推到哪一层？

**检索层——向量召回之前/之中**，而不是召回之后、生成之后：

```text
用户 Query + 可信身份
        ↓
身份解析：user_id / role / dept / tenant / security_level
        ↓
检索层 ACL 预过滤：只保留用户有权访问的文档/chunk 子集
        ↓
在合法子集内执行向量检索 / BM25 / 混合检索
        ↓
RRF 融合
        ↓
Rerank
        ↓
阈值过滤
        ↓
LLM 生成
        ↓
输出层二次敏感校验 + 审计
```

也就是说，**权限过滤发生在相似度计算之前或检索引擎内部**，让模型从一开始就看不到无权内容。

### 工程落地六条

- **入库时绑定 ACL 元数据**：每个 chunk 带 `tenant_id`、`department`、`role`、`user_id`、
  `security_level`、`doc_version` 等标签。
- **检索前解析可信身份**：身份来自企业目录、SSO、JWT 或服务端 Token，**客户端不能自报权限**。
- **检索引擎做前置过滤**：向量库在召回前先用 ACL 元数据裁剪候选空间，只在合法子集里做相似度检索。
- **RRF / Rerank 只在合法候选上跑**：无权文档不能进入融合和精排。
- **输出层二次校验**：防字段级敏感信息、密级升级、权限变更期间的残留。
- **Trace 也要脱敏**：日志、缓存、评测数据同样不能保留无权原文。

### 脱敏 ≠ ACL（两者配合，不能互相替代）

| 能力 | 解决什么 | 不能解决什么 |
|---|---|---|
| ACL | 谁能看哪条数据 | 不改变数据本身 |
| 脱敏 | 敏感字段如何展示 | 不决定谁有权访问原文 |
| 检索层过滤 | 缩小可见候选空间 | 不等同于输出层打码 |

- 脱敏是把「身份证号、手机号、薪资」打码或泛化；ACL 是决定「这个人**根本不该看到**这条文档」。
- 只有脱敏没有 ACL → 用户仍可能看到本不该接触的合同、预算、人事档案；
- 只有 ACL 没有脱敏 → 有权用户又可能看到过细的敏感字段。

> 一句话总结：**私人 RAG 的 ACL 必须作为检索层硬约束，在召回发生前裁剪可见空间；后滤只能做兜底，
> 不能当主防线；脱敏是输出保护，不能替代访问控制。**

---

## 特殊场景速答（PDF / 超长合同）

**11★ 扫描 PDF / OCR**：别整页塞进向量。先**版面分析**（layout analysis）把版面还原成段落/字段，再**字段级 OCR** 逐块识别，把结构化文本 + 位置元数据一起入库；纯图片页要单独处理，避免把版面噪声/页眉页脚当正文。
**12★ 超长合同**：按**结构/条款**切（每条款一个 chunk，独立向量化），再让**子 Agent 各自按 schema 提取自己的领域字段**（金额/期限/违约责任…），最后合并；合同引用的条款编号要保留原文关系，便于溯源与归并。

---

## 知识点总结

| 概念 | 说明 |
|------|------|
| **RAG** | 检索增强生成，把外部知识检索后注入 Prompt，扩展 LLM 的知识边界 |
| **Embedding** | 把文本转成高维向量，语义相近的文本向量距离也近 |
| **Chunking** | 把长文档切成小块，每块独立向量化，便于精准检索 |
| **余弦相似度** | 衡量两个向量方向的相似程度，RAG 检索的核心算法 |
| **向量数据库** | 专门存储和检索向量的数据库，如 Chroma、Pinecone、pgvector |
| **embedMany** | `ai` SDK 提供的批量向量化方法，比逐条调用更高效 |
| **两段式检索** | 先粗召回(top-N)再重排只留 top-k，兼顾「捞得全」与「留得准」 |
| **Rerank（重排）** | 召回后用 cross-encoder 对候选精打分排序，提升精确率 |
| **Cross-encoder** | 把 (问题, 片段) 拼一起过模型打分，Q、P token 互相 attend，精度高 |
| **Query Rewrite / HyDE** | 生成前改写问题/假设答案以提升召回率，与重排是不同环节 |
| **BM25** | 词法相关度打分（词频饱和 + 长度归一化 + 稀有词加权），ES/Lucene 默认排序 |
| **Hybrid 检索 + RRF** | BM25(词面) + 向量(语义) 双路召回，用 Reciprocal Rank Fusion 融合排名 |
| **元数据过滤（Pre-filter）** | 按 chunk 标签（版本/权限/租户/状态）在检索前缩范围，管「范围对不对」，与打分正交 |
| **Permissions Collapse** | 源系统细粒度权限在文档入库后丢失，所有能查库的人可语义命中全部文档 |
| **ACL 下推** | 权限作为检索层硬约束，在相似度计算前裁剪可见空间；召回后过滤只能兜底 |
| **脱敏 vs ACL** | 脱敏管「字段怎么展示」，ACL 管「能不能看」，两者配合、不可互替 |

---

## 延伸阅读

RAG 补的是「读私有 / 最新知识」。若还想让 Agent 评估并修正自己的输出，可以继续看 Reflection / 自我反思一类的设计。同一站点上，工具接入见 [MCP 入门](/blog/mv99u875/) 与 [一平台双角色实践](/blog/mv99wysd/)，跨 Agent 协作见 [A2A](/blog/a2a-agent-to-agent/)。
