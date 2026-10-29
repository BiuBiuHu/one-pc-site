---
title: "RAG — Retrieval-Augmented Generation"
date: 2026-10-23
excerpt: "RAG lets an agent answer questions from a private knowledge base. This post covers chunking, embeddings, vector stores, hybrid BM25+vector+RRF, rerank, OpenSearch, and ACL / Permissions Collapse."
category: AI Infrastructure
lang: en
faq:
  - q: "What problem does RAG solve?"
    a: "An LLM's knowledge comes from training data, with two hard limits — freshness and privacy. RAG (Retrieval-Augmented Generation) retrieves relevant documents and stuffs them into the prompt, so the model can answer from a private knowledge base, not only from what it learned in training."
  - q: "What are the three stages of RAG?"
    a: "Offline, documents are chunked, embedded, and stored in a vector database. Online, the question is embedded, nearest neighbors are retrieved, relevant chunks are stitched into the prompt, and the LLM generates an answer."
  - q: "Why is vector search alone not enough in production?"
    a: "Vectors cover meaning; BM25 covers lexical match. Together with metadata filtering they form multi-path recall, then Reciprocal Rank Fusion merges ranks, and a cross-encoder rerank improves precision. Lock recall first, then add rerank."
  - q: "What is Permissions Collapse, and how should private RAG handle ACL?"
    a: "Permissions Collapse is when fine-grained source-system permissions are lost after documents enter the vector index, so anyone who can query the store may semantically hit every document. Private RAG must push ACL down to the retrieval layer and clip the visible set before similarity search. Filtering after recall is only a backstop; redaction does not replace access control."
  - q: "How do RAG, MCP, and A2A divide the work?"
    a: "On the same agent capability chain, RAG covers reading knowledge, MCP covers using tools, and A2A covers collaborating with other agents. The three complement each other."
---

> Goal: let an agent answer questions from a private knowledge base, not just from what the model learned during training.

---

## Background: the knowledge boundary of LLMs

An LLM's knowledge comes from its training data, with two hard limits:

1. **Freshness**: training data has a cutoff date; the model does not know what happened after that
2. **Privacy**: it does not know your company's internal docs, codebases, or product manuals

**RAG (Retrieval-Augmented Generation)** addresses both:

```
Classic path: user question → LLM (training knowledge only) → answer
RAG path:     user question → retrieve relevant docs → stuff them into the prompt → LLM → answer
```

On the same agent capability chain: RAG covers "reading knowledge", [MCP](/en/blog/mcp-model-context-protocol/) covers "using tools" ([dual-role write-up](/en/blog/mcp-dual-role/)), and [A2A](/en/blog/a2a-agent-to-agent/) covers "collaborating with other agents". The three complement each other.

---

## Core idea: vector similarity retrieval

### Why vectors?

You cannot compare text similarity directly, but you can turn text into an **embedding** — a high-dimensional numeric array. Texts that are close in meaning are also close in vector space.

```
"how to reset a password" → [0.12, -0.34, 0.89, ...]  ← 1536-dim vector
"password recovery steps" → [0.11, -0.35, 0.87, ...]  ← close; similar meaning
"what's the weather today" → [0.78, 0.23, -0.45, ...]  ← far; different meaning
```

### Three stages of RAG

```
[Offline: build the knowledge base]
docs → chunking → embedding → store in a vector database

[Online: retrieve + generate]
user question → embed → nearest neighbors in the vector DB → take relevant chunks
              → stitch into the prompt → LLM generates an answer
```

---

## Implementation: a simple RAG from scratch

### Step 1: Chunking

```typescript
// Split a long document into small pieces, ~500 characters each
// Keep some overlap so key information is not cut in half
function chunkText(text: string, chunkSize = 500, overlap = 50): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));
    start += chunkSize - overlap; // advance by (chunkSize - overlap) to keep overlap
  }

  return chunks;
}
```

### Step 2: Embedding

```typescript
import { embed, embedMany } from 'ai';
import { openai } from '@ai-sdk/openai';

const embeddingModel = openai.embedding('text-embedding-3-small');

// Batch-embed document chunks
async function embedChunks(chunks: string[]): Promise<number[][]> {
  const { embeddings } = await embedMany({
    model: embeddingModel,
    values: chunks,
  });
  return embeddings; // one vector per chunk
}

// Embed the user question
async function embedQuery(query: string): Promise<number[]> {
  const { embedding } = await embed({
    model: embeddingModel,
    value: query,
  });
  return embedding;
}
```

### Step 3: Vector store and retrieval

```typescript
// A simple in-memory vector store (use Chroma, Pinecone, or pgvector in production)
interface VectorDocument {
  id: string;
  content: string;
  embedding: number[];
  metadata?: Record<string, string>;
}

class SimpleVectorStore {
  private documents: VectorDocument[] = [];

  add(doc: VectorDocument): void {
    this.documents.push(doc);
  }

  // Cosine similarity: how aligned two vectors are; range [-1, 1], closer to 1 is more similar
  private cosineSimilarity(vectorA: number[], vectorB: number[]): number {
    const dotProduct = vectorA.reduce((sum, a, i) => sum + a * vectorB[i], 0);
    const magnitudeA = Math.sqrt(vectorA.reduce((sum, a) => sum + a * a, 0));
    const magnitudeB = Math.sqrt(vectorB.reduce((sum, b) => sum + b * b, 0));
    return dotProduct / (magnitudeA * magnitudeB);
  }

  // Retrieve the topK most similar documents
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

### Step 4: The full RAG flow

```typescript
// Wrap RAG as a tool so the agent can call it
const ragSearchTool = tool({
  description: 'Search the knowledge base for documents that answer product or docs questions',
  parameters: z.object({
    query: z.string().describe('Search keywords or a question'),
    topK: z.number().default(3).describe('How many most-relevant documents to return'),
  }),
  execute: async ({ query, topK }) => {
    // 1. Embed the user question
    const queryEmbedding = await embedQuery(query);

    // 2. Retrieve the most relevant chunks
    const relevantDocs = vectorStore.search(queryEmbedding, topK);

    // 3. Return the document text (the agent will inject this into the prompt)
    return {
      documents: relevantDocs.map(doc => ({
        content: doc.content,
        source: doc.metadata?.source ?? 'unknown source',
      })),
      message: `Found ${relevantDocs.length} relevant documents`,
    };
  },
});
```

---

## Offline indexing

```typescript
// One-shot script: embed a document library and store it in the vector DB
async function buildIndex(documents: { content: string; source: string }[]) {
  for (const doc of documents) {
    // 1. Chunk
    const chunks = chunkText(doc.content);

    // 2. Batch embed
    const embeddings = await embedChunks(chunks);

    // 3. Store
    chunks.forEach((chunk, i) => {
      vectorStore.add({
        id: `${doc.source}-${i}`,
        content: chunk,
        embedding: embeddings[i],
        metadata: { source: doc.source },
      });
    });

    console.log(`✅ Indexed: ${doc.source} (${chunks.length} chunks)`);
  }
}

// Example usage
await buildIndex([
  { content: fs.readFileSync('docs/product-manual.md', 'utf-8'), source: 'product-manual' },
  { content: fs.readFileSync('docs/faq.md', 'utf-8'), source: 'faq' },
  { content: fs.readFileSync('docs/api-reference.md', 'utf-8'), source: 'api-reference' },
]);
```

---

## Common RAG optimizations

| Problem | Fix |
|------|----------|
| **Chunks too short**, context incomplete | Increase chunkSize, or chunk by semantics (paragraph / heading) |
| **Chunks too long**, too much noise | Decrease chunkSize, raise topK, then rerank |
| **Retrieval is off** | HyDE: let the LLM write a hypothetical answer, then retrieve with that |
| **Duplicate results** | MMR (Maximal Marginal Relevance) to balance similarity and diversity |
| **Production** | Replace the in-memory store with Chroma, Pinecone, or pgvector for persistence and scale |

---

## The full retrieval pipeline: multi-path recall → RRF fusion → rerank → evidence filter + generation

> The rerank / BM25 pieces above are gathered here into one **runnable pipeline**. The claim:
> **RAG answer quality depends on evidence quality, and evidence quality depends on a layered retrieval design.**

### Why one retriever is not enough

- Vector search is good at **meaning** ("how do I apply for annual leave" can hit "employee leave policy"), but it is insensitive to **literal anchors** — exact terms, proper nouns, version numbers, error codes, API parameters, clause numbers. You get "close in meaning, wrong in detail".
- BM25 **reads the surface** (`temperature=0`, `ERR_5001`, `v2.3.1 upgrade notes` are safest as lexical hits) but does not understand meaning; a paraphrase misses.
- They are **orthogonal**, not substitutes: **vectors ask "does it mean the same?"; BM25 asks "did the word appear?"**.

### Metadata filtering: the third path, about "is the scope right"

Vector / BM25 are **scoring**. Metadata filtering is a **hard constraint** (boolean match, no score) — tag every chunk at ingest
(`source / version / updated_at / dept / authority / tenant_id / doc_type / status`),
then draw the allowed range with boolean conditions at query time:

```json
{
  "query": { "match": { "content": "annual leave application process" } },
  "filter": {
    "bool": { "must": [
      { "term": { "version": "v2" } },
      { "term": { "status": "active" } },
      { "term": { "authority": "hr" } }
    ]}
  }
}
```

**Key: pre-filter (filter, then search). Do not post-filter (search, then delete).**

- ✅ Pre-filter: shrink the candidate space by tags first, then score / recall **inside the legal subset** — correct and faster.
- ❌ Post-filter: recall Top-K first, then delete — Top-K fills up with **old / unauthorized docs**, and after deletion the useful context is gone
  (same three failure modes as the "ACL push-down" section).
- In Elasticsearch this is `filter context` (unscored, cacheable). Do not use `post_filter` as your main filter.

This is also the technical carrier for three things: **the 10★ fix for "recalling an old version"**, **ACL push-down**, and the "is the scope right" path in multi-path recall.

### The four-step pipeline

| Stage | Job | Goal |
|------|------|---------|
| ① Multi-path recall | Vector + BM25 + metadata filter | **Do not miss** key evidence (high recall) |
| ② Fusion | RRF or similar rank fusion | **Unify** outputs from different retrievers (comparable) |
| ③ Rerank | Cross-encoder rerank | **Pick** the right Top-k (high precision) |
| ④ Evidence filter + generate | Score threshold + LLM answer | Fewer hallucinations, more explainable |

```
query ─► ① multi-path recall (vector+BM25+metadata) ─► ② RRF fusion ─► ③ rerank (top-k) ─► ④ threshold + LLM
```

- **① High recall**: pull in anything that might be relevant; better too many than a miss (vectors catch paraphrases + BM25 catches literals + metadata shrinks the range).
- **② Fusion: RRF (keep this straight — RRF ≠ rerank)**
  RRF is "**merging ranks**". Cross-encoder rerank is "**rescoring**". Two jobs, two stages:

  | | RRF (fusion) | Cross-encoder rerank |
  |---|---|---|
  | Stage | After recall, before rerank | Rerank stage |
  | Input | Rank lists from each retriever | The fused candidate list |
  | What it does | Merge those ranks into one order | Jointly score Query + Document |
  | Cost | Very cheap, pure math | Higher; you run a model |

  RRF is based on "**rank position**", not raw scores:

  ```
  RRF(d) = Σ_i  1 / (k + rank_i(d))     # d=doc; rank_i(d)=its rank on path i; k is often 60; skip a path that missed it
  ```

  Example: doc A is rank 2 on the vector path, rank 1 on BM25, missing on a graph path → `1/(k+2) + 1/(k+1)`;
  B is only rank 3 on the vector path → one term, so after fusion it usually sits behind A.
  **Why ranks, not scores**: the scales differ — vector similarity 0.87/0.92, BM25 5.3/12.7,
  graph hit-path counts / relation weights. Adding them is meaningless, and normalizing is messy. RRF turns "what place?" into a comparable contribution.
  A picture: recall = two nets, each landing a catch; RRF = dump both nets and sort by "who ranked it higher"; rerank = inspect each fish and put the truly relevant ones first.
  RRF is cheap (math); rerank is expensive (a model). That is why you **fuse with RRF first, then rerank**.
- **③ Rerank**: rescore the fused candidates (e.g. Top-20~50) with a cross-encoder and keep only top-k for the prompt (details in the "Rerank" section).
- **④ Filter**: if even the top score is too low, the store may have no reliable answer — **answer carefully or refuse**. Otherwise take Top-3~5 as evidence.

### Runnable skeleton (vector + BM25 + RRF, TypeScript)

> This extends the earlier `SimpleVectorStore` (in-memory vectors): build a BM25 inverted index at ingest, recall on both paths, then fuse with RRF.

```typescript
import { embed, embedMany } from 'ai';
import { openai } from '@ai-sdk/openai';

const embeddingModel = openai.embedding('text-embedding-3-small');

// Vector store (reuse SimpleVectorStore; here we only need its "ids ranked by similarity")
interface VecLike { search(emb: number[], topN: number): { id: string }[] }

// ---------- ① Indexing: dual-path ----------
type Doc = { id: string; content: string; metadata: Record<string, string> };

// Fill the vector store and BM25 together; keep an id -> Doc map
function buildIndexes(chunks: Doc[], vec: VecLike, bm25: SimpleBM25Index) {
  const docsById = new Map(chunks.map((c) => [c.id, c]));
  for (const c of chunks) bm25.add(c);
  // ... vectors: embedMany(chunks[i].content) then vec.add({id, embedding}) (see embedChunks above)
  return docsById;
}

// Minimal BM25: tokenize and record which docs contain each term, and how often
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
  description: 'Retrieve and answer from the knowledge base: multi-path recall (BM25+vector) + RRF + evidence filter',
  parameters: z.object({ query: z.string(), topN: z.number().default(20), topK: z.number().default(3) }),
  execute: async ({ query, topN, topK }) => {
    const fused = await chain.recall(query, topN);
    const best = chain.filter(fused, /*minScore*/ 0.4, topK);
    const docs = best.map((id) => chain.byId(id));
    return {
      hit: docs.length > 0,
      message: docs.length ? `Found ${docs.length} pieces of evidence` : 'Not enough relevant evidence; prefer to refuse',
      documents: docs.map((d) => ({ content: d.content, source: d.metadata.source })),
    };
  },
});
```

### Practical rollout (incremental)

1. **Start with**: vector search + rerank — cheap, immediate lift.
2. **Then add**: when the store fills with jargon / product IDs / API docs / policy clauses, add **BM25 + RRF fusion**.
3. A mature system should also make the model **cite sources / mark spans**; if evidence is thin, say "no relevant information found". Caution beats invention.

> One line: **RAG answer quality depends on evidence quality, and evidence quality depends on a layered retrieval design.**

---

## Retrieval optimization: Rerank

**Rerank is the precision layer in RAG**: recall's job is "don't miss"; rerank's job is "don't feed the wrong thing to the LLM".

```
query ─► coarse recall (top-50) ─► rerank (top-50→top-5) ─► inject into prompt
         vector / BM25              cross-encoder / LLM
         fast, high recall          precise, high precision
```

- **First stage: fast + don't miss**: vector / BM25 pull 50~100 candidates (optimize for recall).
- **Second stage: be precise**: rescore candidates and keep only the most relevant top-k for the prompt (raise precision). You only run the expensive model on a short list, so cost stays bounded.

### What it solves (four kinds of recall noise)

Candidates from vector search and BM25 usually mix in:

- **Close in meaning, but not the answer**;
- **Keyword hit, wrong context**;
- **Wrong year, product name, ID, permission, or version**;
- Several chunks talk about the same thing, but **only one is actually usable**.

Rerank rescores those tens-to-hundreds of candidates, puts the truly relevant ones first, and truncates to **Top-3 / Top-5** for the LLM.

### Mechanism: Bi-encoder vs Cross-encoder (why rerank is more accurate)

| | Bi-encoder (coarse recall) | Cross-encoder (rerank) |
|---|---|---|
| Encoding | Query and passage encoded **separately** | `(query, passage)` concatenated, one forward pass |
| Token interaction | Q and P **never see each other** at encode time | Q and P tokens **attend to each other**, catching fine-grained relations |
| Scoring | Cosine similarity | The model emits a relevance score directly |
| Precompute | ✅ Passage vectors computed offline → fast | ❌ Every pair is live → slow |
| Precision | Medium ("overall meaning" is close) | High ("this passage actually answers it") |

> In plain language: coarse recall is "do these two resumes look alike when read separately"; rerank is "put them in the same interview and see if the conversation lands".

So:
- **Vector search asks "do these two vectors look alike?"**;
- **Rerank asks "does this document actually answer this question?"**.

Example: the user asks for "2026 holiday schedule". Vector search may also pull 2024 and 2025 holiday docs (close in meaning);
rerank is much more likely to push **year-mismatched** docs down.

### Typical pipeline (where it sits)

```text
User query
   ↓
Vector + BM25 recall Top-50 ~ Top-100
   ↓
RRF fusion into one ranking        ← RRF = "merge multi-path recall"
   ↓
Rerank the candidates              ← Rerank = "finely score the fused list"
   ↓
Drop low-score docs, take Top-3 ~ Top-5
   ↓
Hand to the LLM
```

### Mainstream rerank models

| Type | Representative models | Notes |
|---|---|---|
| Cross-encoder | BGE-Reranker-v2-m3, Qwen3-Reranker | High precision; strong on Chinese / multilingual |
| Listwise | Jina Reranker v3.5, mxbai-rerank-v3 | Sees several candidates at once; more consistent order |
| Late interaction | ColBERT | Faster than a cross-encoder; good for large stores |
| LLM rerank | RankLLM, Qwen3 | Strong understanding, expensive; best on small candidate sets |

### How to choose in production

- **Chinese RAG, private deploy**: prefer **BGE-Reranker-v2-m3**.
- **Long docs, heavier reasoning**: **Qwen3-Reranker-4B/8B**.
- **Low latency, large-scale recall**: **ColBERT** or a light listwise model.
- **Quick validation**: call a Rerank API (Cohere, Jina, SiliconFlow, …).

### Three concrete approaches

1. **Cross-encoder models**: closed-source **Cohere Rerank** (common in production); open-source **BGE-reranker**, `cross-encoder/ms-marco-MiniLM`, etc. Input `(query, candidate[])`, output one score per candidate.
2. **LLM as reranker**: stuff candidates into a "rank by relevance" prompt and let the LLM score / sort. Useful when the domain jargon is unknown to a generic reranker; the cost is another LLM call.
3. **A clarification**: BM25 + vector RRF is often lumped under "rerank", but strictly it is the **previous stage (fusion)** — it merges two paths. Rerank does the fine filter. Use them together (see "The full retrieval pipeline").

### Division of labor with query rewrite

On this chain of responsibility —

- **Rewrite (query rewrite / HyDE) sits [before] recall**: reshape the question into a form that retrieves better, raising **recall** (get it all).
- **Rerank sits [after] recall**: filter the candidates, raising **precision** (keep the right ones).
- One covers "get it all", the other "keep it right". Do not collapse them into one step.

### A key principle: lock recall first, then add rerank

Rerank can only "pick the best from good candidates". **It cannot invent something that was never recalled.** If Recall@50 is already low,
coarse recall has missed the key evidence, and rerank will not help much. A more stable upgrade order:

```
chunking strategy → hybrid retrieval → RRF fusion → rerank → threshold filter → LLM generate
```

### Rerank wiring skeleton (BGE-Reranker + truncate to Top-5)

This sits after `RetrievalChain`'s RRF fusion: **fused Top-N → rerank → threshold → Top-5 into the LLM**.

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
  console.log('No sufficiently relevant material in the knowledge base');
} else {
  const context = documents.map((d, i) => `[${i + 1}] ${d.content}`).join('\n\n');
  // generateText({ prompt: `Answer only from the material below and cite the numbers:\n${context}\n\nQuestion: ${query}` })
}
```

**Three points**:
1. **Two-stage truncation**: `topN=20` (coarse keep after fusion) → `rerankK=5` (fine keep after rerank). Wide, then narrow.
2. **The score's meaning changed**: RRF scores are only for ordering. **Thresholding must use the rerank `relevance_score`** — that is the measure of "does this document actually answer the question".
3. **Refuse rather than invent**: `minRelevance` plus an empty-result "no relevant information" branch makes thin evidence visible.

---

## Lexical retrieval: BM25 (complements vectors)

**BM25 (Best Matching 25)**, which shows up throughout recall / rerank, is the classic **lexical (keyword) relevance** scorer,
and the default ranking in **Lucene / Elasticsearch / OpenSearch**. It is TF-IDF's successor. Simplified:

```
score(D,Q) = Σ for each query term q:
   IDF(rarity) × term-frequency term (with saturation) × length norm
   - IDF         : rarer across the collection → larger contribution
   - TF term     : more occurrences score higher, but 【saturate】 (k1≈1.2 caps stuffing)
   - Length norm : long docs are discounted so they don't win just by being long (b≈0.75)
```

- **TF saturation**: 3 vs 100 occurrences of the same term is not that different; `k1` punishes keyword stuffing.
- **Length normalization**: a long doc that happens to contain a term ≠ highly relevant; `b` removes that bias.
- **Rare-term boost**: a precise term (`password_reset_timeout`) contributes more than a stopword (`the`).

**Complementary to embeddings / vectors**:

| | BM25 (lexical) | Embedding (semantic) |
|---|---|---|
| Match | **Exact surface form** | Close in meaning (paraphrases hit) |
| Strength | Exact terms, IDs, proper nouns | Natural language, synonyms |
| Weakness | A paraphrase misses | Exact keywords / unknown proper nouns slip |
| Cost | Fast, no model | Needs embedding + a vector store |

> BM25 reads the "letters"; vectors read the "meaning". Production RAG usually does **hybrid: BM25 + vector dual-path recall → RRF fusion**,
> so vectors recover paraphrases and BM25 covers exact terms / IDs, then both feed rerank.

### BM25 storage requirements (indexing checklist)

**Core premise**: BM25 scores are **computed at query time** (they depend on the query terms). Storage has to keep the "raw materials" —
the opposite of embeddings (those are precomputed offline; query time is just cosine). BM25 scores differ on every query and **cannot be pre-stored**.

**The four things you must store**:

| What to store | Why |
|-----------|------|
| **Inverted list**: term → (chunk_id, tf) | Who the query term hit, and how often |
| **df**: how many chunks contain each term | IDF (rare-term boost) |
| **Field length**: tokens per chunk + collection avgdl | Length norm (`b`) |
| **Tokenization / analyzer config** | How words are split, lowercased, stemmed |

(`SimpleBM25Index`'s `df` / `tf` maps are the minimal version; ES / Lucene maintain this for you.)

**Six hard requirements**:

1. **Same analyzer**: index time and query time must use **the same analyzer** (mismatch = terms don't line up = you find nothing). For Chinese, use IK / HanLP / smartcn; upgrading the tokenizer = a **full rebuild** of the BM25 index.
2. **Right field types**: body as `text` (analyzed, inverted); IDs / codes as a separate `keyword` subfield. Don't mix them.
3. **Don't turn off norms**: that is where field length lives; without it, length norm is dead.
4. **Granularity = one BM25 doc per chunk**: too-long chunks distort (length-normed down) and add noise; too-short chunks fragment hits (see the 8★ A/B). Strong signals like titles can be separate weighted fields.
5. **Keep stats in sync on add/delete**: `df` and `avgdl` change as docs come and go. In ES, a deleted doc still counts until segment merge. **A source-doc update must rebuild that chunk's lexical index** (see 10★ index sync).
6. **Share `chunk_id` across both paths**: `id → embedding` (vector store) and `id → (term, tf, length)` (BM25) must line up, or RRF cannot merge by id.

> One line: **storing BM25 = storing "inverted lists + df + length stats + analyzer config". The score itself is not stored (and cannot be); each query computes it from those materials.**

---

## Production: hybrid search on OpenSearch

> The handwritten skeleton (BM25 inverted index + `rrf()` + metadata filter) maps in production to **OpenSearch's "one doc, three fields + one hybrid query + one RRF pipeline"** — most of the handwritten logic moves into the server.

### 1. Mapping: one doc, three fields (text / vector / metadata)

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

At index time, the same chunk's `content` (text) + `content_embed` (embedding) + metadata go into one doc.
ES **automatically** builds a BM25 inverted index on `text` (you don't add a column by hand) and a vector index on `dense_vector`.

### 2. One hybrid query: BM25 + kNN together

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
            { "match": { "content": "employee leave policy" } },
            { "knn": { "content_embed": { "vector": [/*...*/], "k": 50 } } }
          ]
        }
      }]
    }
  }
}
```

> Don't use `post_filter` as the main filter — it runs after recall / aggregations, i.e. "Top-K fills up, then you delete" (see "Metadata filtering: pre-filter vs post-filter").

### 3. RRF fusion: a search-pipeline normalization processor

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

### 4. Chinese tokenization: the analyzer is the real production pitfall

The `standard` analyzer splits Chinese as "whole span / character by character" — recall is coarse. Production usually installs **IK / HanLP / smartcn**,
sets the analyzer to `ik_smart` / `ik_max_word`, and turns `员工休假管理制度` into `员工|休假|管理|制度`.
That is the production fix for the earlier `[a-z0-9_]` regex failing on Chinese.

### 5. Where rerank plugs in

Recall (50~100) + fusion come back from OpenSearch; **you still attach rerank yourself**: feed top-N to Cohere Rerank / your own
cross-encoder, or hang an OpenSearch neural-search text-rerank pipeline — the skeleton's "fused topN → topK" step.

### Comparison: handwritten skeleton vs OpenSearch

| Handwritten skeleton | OpenSearch |
|---|---|
| You write the inverted index + `rrf()` | `text` auto-BM25 + `hybrid query` + normalization (RRF) processor |
| You maintain df/tf maps | Server-side inverted index + stats |
| Metadata filter by hand | One `filter` / `post_filter` clause |
| Bare regex fails on Chinese | `ik_smart` / `smartcn` plugins |
| Cross-encoder wired outside | External rerank, or a neural-search pipeline |

One line: **in production, OpenSearch is "one doc, three fields + one hybrid query + one RRF pipeline" replacing every handwritten piece; what you still own is chunking, embedding, and a cross-encoder after fusion.**

---

## Advanced: long-doc indexing / diagnosis / provenance (interview-oriented)

### 8★ How to index long documents, and how to pick a chunk size

- **Cut on structure**: prefer semantic boundaries — headings, paragraphs, tables, clauses — not a rigid fixed length. A semantically complete chunk embeds much better.
- **Metadata carries version / ACL**: every chunk needs `version`, `source`, `authority`, or you cannot expire, cite, or permission-trim.
- **Overlap to avoid a hard cut**: key information sitting on a boundary can be sliced in half; keep a small overlap so it is not lost.
- **Pick chunk size with an A/B**: don't invent "500 tokens" by feel. Hold other variables fixed, sweep `chunk_size` (with rerank as a backstop), and read the measured recall / precision curves.

### 9★ Where to optimize when quality is poor

Split the work into a **chain of responsibility**. Each layer owns one step and has independently verifiable cost:

```
parse → chunk → rewrite (query rewrite) → retrieve → rerank → generate
```

| Layer | Owns | How to verify |
|----|--------|---------|
| Parse | PDF / Word → clean text (OCR, layout restore) | Is the source extracted correctly? |
| Chunk | Is each chunk semantically complete? | Sample random chunks and read them |
| Rewrite | Does the query retrieve the right answer? | Measure recall before vs after rewrite |
| Retrieve | Did you get candidates? | Is the gold answer in top-50? |
| Rerank | Did the gold answer rise to top-k? | Is it in top-5? |
| Generate | Given the right material, is the answer right? | Unit-test generation quality |

**Take the earliest broken step as the root cause**: if parse / chunk is wrong at the source, no amount of retrieve / rerank tuning helps. Debug top-down; look at the first layer that fails.

### 10★ The right answer is in the store, but you recall an old version

Don't blame "similarity" first. **"Searching right" presupposes "the store itself is right"** —

1. **Check version metadata**: several file versions coexist, chunks still carry the old `version`, and the query did not filter by version → prefer the **latest**.
2. **Expiry filter**: are retired / expired docs still in the index? Is there an active-status flag and a periodic sync?
3. **Index sync**: after a source update, did the vector store incrementally rebuild? Did old chunks linger?
4. Only after those are ruled out, return to similarity itself: chunks too large / scattered, surface-form mismatch, embedding domain mismatch, etc.

> One line: **"recalling an old version" is almost always a data / index problem, not a retrieval-algorithm problem.**

---

## Security: private RAG ACL must be pushed down to the retrieval layer

> **Lead with the conclusion**: private RAG must push ACL down to the retrieval layer. Filtering after recall is not enough, and redaction cannot replace ACL.

### Permissions Collapse: enterprise RAG is not a public search engine

The same knowledge base holds all-hands policies, department-internal docs, management operating data,
finance / HR / contracts / customer files, plus project- / tenant- / classification-scoped content.

If retrieval has no permission isolation, a natural-language question can **pull unauthorized chunks into the context**.
Once the model sees them, it can leak them **indirectly** via summary, rewrite, or inference.

That is **Permissions Collapse**: the source system had fine-grained permissions, but after docs enter the vector index
the ACL metadata is gone, and **anyone who can query the store can semantically hit every document**.

### Why "filter after recall" fails (three fatal problems)

**1. Unauthorized data is already in the candidate set**
Recall has already loaded unauthorized docs into memory, into the candidate pool, and possibly into rerank, prompt assembly, and traces.
Filtering only "hides them at the end". **The leak window is already open.**

**2. Top-K fills up with unauthorized docs**
Suppose Top-K=5 and recall has 4 unauthorized + 1 authorized. Post-filter drops 4 and leaves 1 — on the surface you "filtered",
in reality **useful context is emptied** and recall quality collapses.

**3. Traces, caches, and logs leak**
Raw recalled text, scores, prompts, and rerank I/O often land in LangSmith / Langfuse / SIEM / homegrown logs.
If ACL is not enforced at retrieval, those pipes can retain **unauthorized fragments**.

### Where should ACL be pushed?

**The retrieval layer — before / during vector recall**, not after recall or after generation:

```text
User query + trusted identity
        ↓
Identity resolution: user_id / role / dept / tenant / security_level
        ↓
Retrieval-layer ACL pre-filter: keep only docs / chunks the user may see
        ↓
Vector / BM25 / hybrid search inside that legal subset
        ↓
RRF fusion
        ↓
Rerank
        ↓
Threshold filter
        ↓
LLM generate
        ↓
Output-layer second sensitivity check + audit
```

In other words, **permission filtering happens before similarity, or inside the search engine**, so the model never sees unauthorized content in the first place.

### Six engineering rules

- **Bind ACL metadata at ingest**: every chunk carries `tenant_id`, `department`, `role`, `user_id`,
  `security_level`, `doc_version`, and similar tags.
- **Resolve a trusted identity before search**: identity comes from the directory, SSO, JWT, or a server-side token. **The client must not self-report privileges.**
- **The search engine pre-filters**: the vector store trims the candidate space with ACL metadata before recall, and only scores inside the legal subset.
- **RRF / rerank run only on legal candidates**: unauthorized docs must not enter fusion or rerank.
- **Second check at the output layer**: field-level secrets, classification upgrades, leftovers during a permission change.
- **Redact traces too**: logs, caches, and eval sets must not keep unauthorized source text.

### Redaction ≠ ACL (they cooperate; they do not replace each other)

| Capability | Solves | Does not solve |
|---|---|---|
| ACL | Who may see which row | Does not change the data itself |
| Redaction | How sensitive fields are shown | Does not decide who may see the original |
| Retrieval-layer filter | Shrinks the visible candidate space | Is not the same as output-layer masking |

- Redaction masks or generalizes "ID number, phone, salary". ACL decides "this person **must not see this document at all**".
- Redaction without ACL → users can still see contracts, budgets, HR files they should never touch;
- ACL without redaction → authorized users may still see overly fine-grained secrets.

> One line: **private RAG ACL is a hard retrieval-layer constraint that trims the visible space before recall. Post-filter is a backstop,
> not the main defense. Redaction is output protection; it does not replace access control.**

---

## Special cases (PDF / very long contracts)

**11★ Scanned PDF / OCR**: do not dump a whole page into the vector store. Run **layout analysis** first to restore paragraphs / fields, then **field-level OCR** block by block, and ingest structured text plus position metadata. Handle image-only pages separately so layout noise / headers / footers are not treated as body text.
**12★ Very long contracts**: cut on **structure / clauses** (one chunk per clause, embedded independently), let **sub-agents extract their own domain fields against a schema** (amount / term / breach…), then merge. Keep the original clause-number relationships so you can cite and reconcile.

---

## Concept summary

| Concept | What it is |
|------|------|
| **RAG** | Retrieval-Augmented Generation: retrieve external knowledge, inject it into the prompt, and extend the LLM's knowledge boundary |
| **Embedding** | Turn text into a high-dimensional vector; close meaning → close vectors |
| **Chunking** | Split long docs into small pieces, each embedded independently, for precise retrieval |
| **Cosine similarity** | How aligned two vectors are; the core scoring for RAG retrieval |
| **Vector database** | A store built for vectors, e.g. Chroma, Pinecone, pgvector |
| **embedMany** | Batch embedding in the `ai` SDK; cheaper than one-by-one calls |
| **Two-stage retrieval** | Coarse recall (top-N) then rerank down to top-k: "get it all" and "keep it right" |
| **Rerank** | After recall, a cross-encoder finely scores candidates to raise precision |
| **Cross-encoder** | `(query, passage)` in one forward pass; Q and P tokens attend; high precision |
| **Query rewrite / HyDE** | Rewrite the question or a hypothetical answer *before* generation to raise recall; a different stage from rerank |
| **BM25** | Lexical relevance (TF saturation + length norm + rare-term boost); default ranking in ES / Lucene |
| **Hybrid retrieval + RRF** | BM25 (surface) + vector (meaning) dual-path recall, fused with Reciprocal Rank Fusion |
| **Metadata filter (pre-filter)** | Shrink range by chunk tags (version / ACL / tenant / status) *before* search; orthogonal to scoring |
| **Permissions Collapse** | Source-system fine-grained ACL is lost after ingest, so anyone who can query can semantically hit every doc |
| **ACL push-down** | Permissions as a hard retrieval-layer constraint, trimming visibility before similarity; post-recall filter is only a backstop |
| **Redaction vs ACL** | Redaction is "how a field is shown"; ACL is "whether you may look"; they cooperate and do not replace each other |

---

## Further reading

RAG covers "reading private / fresh knowledge". If you also want an agent to evaluate and correct its own output, look at Reflection-style designs next. On this site, tool access is in [MCP intro](/en/blog/mcp-model-context-protocol/) and [one platform, two MCP roles](/en/blog/mcp-dual-role/); cross-agent collaboration is in [A2A](/en/blog/a2a-agent-to-agent/).
