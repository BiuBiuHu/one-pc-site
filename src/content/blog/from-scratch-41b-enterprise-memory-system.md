---
title: "企业级 Agent Memory 系统设计指南"
date: 2026-11-25
excerpt: "生产级记忆系统的完整工程方案是什么？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 43
---

> 从"玩具级聊天记录"到"生产级记忆系统"的完整工程方案

---

## 与前课的关系（第 41 课之二）

前情回顾：第 9 课的[记忆系统](/blog/from-scratch-09-memory-system/)已经让 Agent 能用 embedding 实现**跨会话的长期记忆**，第 40 课 Harness 工程讲了用约束把 AI 输出做成可靠产出。本篇（第 41b 课）与[第 41a 课 Ralph Loop](/blog/from-scratch-41a-ralph-loop/)并列构成第 41 课，把记忆从"能记住"升级成"生产级子系统"：

| # | 篇目 | 专注 | 一句话 |
|---|------|------|--------|
| 41a | Ralph Loop | 自主迭代范式 | 让 AI 自己跑到天亮的编排循环 |
| 41b | 企业级 Memory | 记忆子系统工程 | 让 Agent 记得住、召得准、不外泄 |

> 两者正交：41a 解决"怎么不断迭代"，本篇解决"迭代过程中怎么持续记住上下文"。读完第 9 课再读本篇最顺——本篇是第 9 课从 demo 走向企业级的完整落地。

---

## 一、为什么 Memory 是企业级 Agent 最难做好的部分

### 没有 Memory 的 Agent vs 有 Memory 的 Agent

| 场景 | 无 Memory | 有 Memory |
|------|----------|----------|
| 用户说"按上次的风格写" | ❌ "什么风格？请描述" | ✅ 自动检索上次生成的内容风格 |
| 跨会话记住用户偏好 | ❌ 每次重新问 | ✅ 记住"用户喜欢简洁回复、不要总结" |
| 长对话中间忘了开头说的约束 | ❌ 上下文窗口溢出后丢失 | ✅ 关键约束持久化，随时召回 |
| 多轮任务中断后恢复 | ❌ 从头开始 | ✅ 从断点继续，保留中间状态 |
| 团队协作共享知识 | ❌ 每人独立 | ✅ 团队知识库共享 |

### 核心挑战

```
┌─────────────────────────────────────────────────┐
│           Memory 的三大矛盾                       │
│                                                  │
│  1. 记太多 vs 记太少                               │
│     全存 → token 爆炸、噪声淹没信号                 │
│     少存 → 关键时刻想不起来                         │
│                                                  │
│  2. 精确召回 vs 模糊联想                            │
│     精确匹配 → "上次那个支付流程"搜不到              │
│     语义搜索 → 召回一堆不相关的                     │
│                                                  │
│  3. 实时写入 vs 异步整理                            │
│     实时写 → 每条消息都调 Embedding API，慢且贵      │
│     异步写 → 刚说的话还没入库就被问了                │
└─────────────────────────────────────────────────┘
```

---

## 二、Memory 的四层架构（企业级标准）

```
┌─────────────────────────────────────────────────────────┐
│  Layer 4: Knowledge Base（知识库）                        │
│  团队/项目级共享知识，更新频率低，权威性强                  │
│  例：API 文档、业务规则、代码规范、历史决策记录             │
├─────────────────────────────────────────────────────────┤
│  Layer 3: Long-term Memory（长期记忆）                    │
│  用户级持久化偏好和事实，跨会话保留                        │
│  例：用户角色、编码习惯、项目背景、反馈纠正                 │
├─────────────────────────────────────────────────────────┤
│  Layer 2: Working Memory（工作记忆）                      │
│  当前任务的中间状态和上下文，会话内有效                     │
│  例：任务计划、已完成的步骤、待办事项、临时变量             │
├─────────────────────────────────────────────────────────┤
│  Layer 1: Conversation Buffer（对话缓冲）                 │
│  最近 N 轮原始对话，短期滑动窗口                           │
│  例：最近 10 轮 user/assistant 消息                       │
└─────────────────────────────────────────────────────────┘
```

### 各层对比

| 层级 | 生命周期 | 存储位置 | 写入时机 | 读取方式 | 数据量 |
|------|---------|---------|---------|---------|--------|
| **L1 Buffer** | 单次会话 | 内存 / Redis | 每轮对话实时写入 | 直接拼接进 Prompt | 小（~4K tokens） |
| **L2 Working** | 单次任务 | 内存 + DB | 任务状态变更时 | 结构化查询 | 中（~8K tokens） |
| **L3 Long-term** | 永久 | 向量库 + KV DB | 异步提炼后写入 | 语义检索 + Key 查询 | 大（按需召回） |
| **L4 Knowledge** | 永久 | 向量库 + 文档库 | 人工/自动化导入 | RAG 检索 | 极大（按需召回） |

---

## 三、Layer 1：Conversation Buffer（对话缓冲）

### 最简单的 Memory，但最容易做错

#### ❌ 常见错误：把所有历史消息塞进 Prompt

```typescript
// 错误：对话 50 轮后，Prompt 超过 100K tokens
const messages = allHistoryMessages; // 💥 token 爆炸
```

#### ✅ 正确做法：滑动窗口 + 摘要压缩

```typescript
// ─── 基础类型定义 ──────────────────────────────────────────────────────────
interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface Summarizer {
  /** 将一组消息 + 已有摘要 → 新的合并摘要 */
  summarize(messages: Message[], existingSummary: string | null): Promise<string>;
}

/** LLM 驱动的摘要器实现 */
class LLMSummarizer implements Summarizer {
  constructor(private llmClient: LLMClient) {}

  async summarize(messages: Message[], existingSummary: string | null): Promise<string> {
    const messagesText = messages
      .map(m => `${m.role}: ${m.content.slice(0, 500)}`)
      .join('\n');

    const prompt = SUMMARY_PROMPT
      .replace('{messages}', messagesText)
      .replace('{existingSummary}', existingSummary || '无');

    return this.llmClient.generate(prompt);
  }
}

interface ConversationBuffer {
  /** 保留最近 N 轮原始消息 */
  recentMessages: Message[];
  /** 更早的消息被压缩为摘要 */
  summary: string | null;
  /** 窗口大小 */
  windowSize: number;
}

class SlidingWindowBuffer {
  private messages: Message[] = [];
  private summary: string | null = null;
  private readonly windowSize: number;

  constructor(windowSize: number = 10) {
    this.windowSize = windowSize;
  }

  async addMessage(message: Message, summarizer?: Summarizer): Promise<void> {
    this.messages.push(message);

    // 超出窗口时，把旧消息压缩为摘要
    if (this.messages.length > this.windowSize * 2) {
      const oldMessages = this.messages.slice(0, this.messages.length - this.windowSize);
      this.messages = this.messages.slice(-this.windowSize);

      // 将旧消息 + 已有摘要 → 新摘要
      if (summarizer) {
        this.summary = await summarizer.summarize(oldMessages, this.summary);
      } else {
        // 无 summarizer 时的降级：简单拼接关键信息
        const fallbackSummary = oldMessages
          .filter(m => m.role === 'user')
          .map(m => m.content.slice(0, 100))
          .join('; ');
        this.summary = this.summary
          ? `${this.summary}\n\n[Earlier context]: ${fallbackSummary}`
          : `[Earlier context]: ${fallbackSummary}`;
      }
    }
  }

  /** 获取用于 Prompt 的消息列表 */
  getPromptMessages(): Message[] {
    const result: Message[] = [];

    // 摘要放在最前面（作为 system message）
    if (this.summary) {
      result.push({
        role: 'system',
        content: `[Previous conversation summary]\n${this.summary}`,
      });
    }

    // 最近的原始消息
    result.push(...this.messages);
    return result;
  }

  /** 获取当前消息数量 */
  getMessageCount(): number {
    return this.messages.length;
  }

  /** 清空缓冲 */
  clear(): void {
    this.messages = [];
    this.summary = null;
  }
}
```

#### 摘要压缩的策略

| 策略 | 适用场景 | 实现 |
|------|---------|------|
| **LLM 摘要** | 通用场景，效果最好 | 调用 LLM 生成摘要，成本较高 |
| **提取式摘要** | 低成本场景 | 提取关键实体、决策点、TODO |
| **结构化摘要** | 任务型对话 | 只保留：目标、已完成步骤、待办、关键约束 |
| **增量摘要** | 长对话 | 每次只摘要新增部分，与旧摘要合并 |

```typescript
// 结构化摘要模板（推荐用于 Agent 场景）
const SUMMARY_PROMPT = `请将以下对话压缩为结构化摘要，保留关键信息：

## 输出格式
- **用户目标**: <一句话描述用户最终想达成什么>
- **已完成**: <已完成的步骤列表>
- **进行中**: <当前正在做的事>
- **待办**: <尚未开始的步骤>
- **关键约束**: <用户明确提出的约束和要求>
- **重要发现**: <过程中发现的关键信息>
- **未解决问题**: <悬而未决的问题>

## 对话内容
{messages}

## 已有摘要（如有）
{existingSummary}

请将新信息与已有摘要合并，输出一份更新后的完整摘要。`;
```

---

## 四、Layer 2：Working Memory（工作记忆）

### 解决"Agent 做到一半忘了自己在干什么"

Working Memory 不是聊天记录，而是**当前任务的结构化状态**。

```typescript
interface WorkingMemory {
  /** 任务目标 */
  goal: string;

  /** 执行计划（可能随执行动态调整） */
  plan: PlanStep[];

  /** 当前进度 */
  currentStepIndex: number;

  /** 已收集的关键信息（避免重复搜索） */
  collectedFacts: Map<string, string>;

  /** 待确认的问题 */
  pendingQuestions: string[];

  /** 中间产出物 */
  artifacts: Map<string, any>;

  /** 错误历史和修复尝试（避免重复犯错） */
  errorHistory: { error: string; attemptedFix: string; result: string }[];
}

interface PlanStep {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
  dependencies: string[];
  output?: any;
}
```

### Working Memory 的核心操作

```typescript
class WorkingMemoryManager {
  private memory: WorkingMemory;

  /** 初始化任务 */
  initTask(goal: string, plan: PlanStep[]): void {
    this.memory = {
      goal,
      plan,
      currentStepIndex: 0,
      collectedFacts: new Map(),
      pendingQuestions: [],
      artifacts: new Map(),
      errorHistory: [],
    };
  }

  /** 记录已收集的事实（避免重复搜索） */
  recordFact(key: string, value: string): void {
    this.memory.collectedFacts.set(key, value);
  }

  /** 检查是否已经知道某个事实 */
  hasFact(key: string): boolean {
    return this.memory.collectedFacts.has(key);
  }

  /** 记录错误和修复尝试 */
  recordError(error: string, attemptedFix: string, result: string): void {
    this.memory.errorHistory.push({ error, attemptedFix, result });
  }

  /** 获取当前状态的快照（注入 Prompt） */
  getSnapshot(): string {
    const completedSteps = this.memory.plan
      .filter(s => s.status === 'completed')
      .map(s => `✅ ${s.description}`);
    const currentStep = this.memory.plan[this.memory.currentStepIndex];
    const pendingSteps = this.memory.plan
      .filter(s => s.status === 'pending')
      .map(s => `⬜ ${s.description}`);

    const facts = Array.from(this.memory.collectedFacts.entries())
      .map(([k, v]) => `- ${k}: ${v}`);

    const errors = this.memory.errorHistory.length > 0
      ? this.memory.errorHistory.map(e => `- ❌ ${e.error} → 尝试: ${e.attemptedFix} → 结果: ${e.result}`)
      : ['无'];

    return `
## 当前任务状态
**目标**: ${this.memory.goal}

**已完成**:
${completedSteps.join('\n') || '无'}

**当前步骤**: ${currentStep?.description || '全部完成'}

**待办**:
${pendingSteps.join('\n') || '无'}

**已收集的信息**:
${facts.join('\n') || '无'}

**错误历史**:
${errors.join('\n')}
`.trim();
  }
}
```

### 持久化：任务中断后恢复

```typescript
// 将 Working Memory 序列化到数据库，支持跨会话恢复
async function persistWorkingMemory(taskId: string, memory: WorkingMemory): Promise<void> {
  await db.collection('working_memories').updateOne(
    { taskId },
    {
      $set: {
        goal: memory.goal,
        plan: memory.plan,
        currentStepIndex: memory.currentStepIndex,
        collectedFacts: Object.fromEntries(memory.collectedFacts),
        pendingQuestions: memory.pendingQuestions,
        errorHistory: memory.errorHistory,
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );
}

// 恢复
async function restoreWorkingMemory(taskId: string): Promise<WorkingMemory | null> {
  const doc = await db.collection('working_memories').findOne({ taskId });
  if (!doc) return null;

  return {
    goal: doc.goal,
    plan: doc.plan,
    currentStepIndex: doc.currentStepIndex,
    collectedFacts: new Map(Object.entries(doc.collectedFacts)),
    pendingQuestions: doc.pendingQuestions,
    artifacts: new Map(),  // artifacts 不持久化（太大）
    errorHistory: doc.errorHistory,
  };
}
```

---

## 五、Layer 3：Long-term Memory（长期记忆）

### 这是企业级 Memory 的核心差异化能力

Long-term Memory 解决的是：**跨会话记住用户是谁、喜欢什么、之前做过什么**。

### 5.1 记忆类型分类

| 类型 | 内容 | 示例 | 存储方式 |
|------|------|------|---------|
| **User Profile** | 用户身份、角色、技能水平 | "资深 Java 工程师，React 新手" | KV Store |
| **Preferences** | 交互偏好、输出格式偏好 | "不要总结、代码不加注释" | KV Store |
| **Feedback** | 用户的纠正和确认 | "别 mock 数据库，用真实连接" | KV Store + 向量 |
| **Facts** | 关于项目/环境的客观事实 | "部署分支是 release/v2" | 向量库 |
| **Episodic** | 过去的事件和经验 | "上次重构认证模块花了 3 天" | 向量库 |
| **Procedural** | 学到的操作流程 | "发布前先跑集成测试" | 向量库 + KV |

### 5.2 记忆的写入：不是什么都值得记

```typescript
interface MemoryWriteDecision {
  shouldWrite: boolean;
  memoryType: MemoryType;
  content: string;
  importance: number;       // 0-1，低于阈值不写
  ttl?: number;             // 过期时间（秒），null = 永久
}

/**
 * 用 LLM 判断一条对话是否值得记忆
 * 这是企业级 Memory 的关键——不是全存，而是智能筛选
 */
const MEMORY_EXTRACTION_PROMPT = `分析以下对话，判断是否有值得长期记忆的信息。

## 对话
User: {userMessage}
Assistant: {assistantMessage}

## 已有的用户记忆
{existingMemories}

## 判断标准
值得记忆的信息包括：
1. 用户明确表达的偏好（"我喜欢..."、"不要..."、"请用..."）
2. 用户对 AI 行为的纠正（"不对"、"应该是..."、"别这样做"）
3. 用户透露的身份/角色/技能信息
4. 关于项目/环境的重要事实
5. 用户确认了某个非显而易见的做法

不值得记忆的：
- 临时的调试信息
- 一次性的问答
- 可以从代码/Git 推导出的信息
- AI 自己的推理过程

## 输出格式（JSON）
{
  "memories": [
    {
      "type": "preference|feedback|fact|profile|episodic",
      "content": "记忆内容（简洁、自包含）",
      "importance": 0.0-1.0,
      "reason": "为什么值得记忆"
    }
  ]
}

如果没有值得记忆的信息，返回 {"memories": []}`;
```

### 5.3 记忆的存储：双存储架构

```
┌─────────────────────────────────────────────┐
│              Long-term Memory                │
│                                              │
│  ┌──────────────┐   ┌──────────────────┐    │
│  │  KV Store     │   │  Vector Store    │    │
│  │  (精确查询)   │   │  (语义检索)      │    │
│  │              │   │                  │    │
│  │ key:         │   │ embeddings:      │    │
│  │  user_role   │   │  "用户不喜欢     │    │
│  │  pref_style  │   │   冗长的解释"    │    │
│  │  proj_branch │   │  "上次部署失败   │    │
│  │              │   │   因为缺少env"   │    │
│  └──────────────┘   └──────────────────┘    │
│                                              │
│  精确查询用 KV    模糊联想用 Vector            │
│  "用户的角色是什么"  "用户之前遇到过什么问题"    │
└─────────────────────────────────────────────┘
```

```typescript
// ─── Long-term Memory 相关类型定义 ──────────────────────────────────────────
type MemoryType = 'profile' | 'preference' | 'feedback' | 'fact' | 'episodic' | 'procedural';

interface MemoryEntry {
  id: string;
  userId: string;
  type: MemoryType;
  key?: string;                     // KV 查询用的键（profile/preference 类型必填）
  content: string;
  importance: number;               // 0-1
  source: 'kv' | 'vector';
  relevance?: number;               // 语义检索时的相关性分数
  createdAt: Date;
  lastAccessedAt?: Date;
}

interface MemorySearchResult {
  content: string;
  type: MemoryType;
  relevance: number;
  createdAt: Date;
}

interface RecallOptions {
  keys?: string[];                  // 精确查询的 key 列表
  type?: MemoryType;                // 限定记忆类型
  topK?: number;                    // 语义检索条数
  minRelevance?: number;            // 最低相关性阈值
}

/** KV Store 抽象接口 */
interface KVStore {
  get(key: string): Promise<{ content: string; updatedAt: Date; importance: number } | null>;
  set(key: string, value: { content: string; updatedAt: Date; importance: number }): Promise<void>;
  delete(key: string): Promise<void>;
  listByPrefix(prefix: string): Promise<{ key: string; value: any }[]>;
}

/** Vector Store 抽象接口 */
interface VectorStore {
  upsert(item: {
    id: string;
    embedding: number[];
    metadata: Record<string, any>;
    document: string;
  }): Promise<void>;
  search(
    queryEmbedding: number[],
    options: { filter?: Record<string, any>; topK: number; minScore?: number }
  ): Promise<{ id: string; document: string; score: number; metadata: Record<string, any> }[]>;
  list(options: { filter?: Record<string, any> }): Promise<{
    id: string;
    document: string;
    metadata: Record<string, any>;
  }[]>;
  delete(id: string): Promise<void>;
}

/** Embedder 抽象接口 */
interface Embedder {
  embed(text: string): Promise<number[]>;
}

class LongTermMemoryStore {
  constructor(
    private kvStore: KVStore,
    private vectorStore: VectorStore,
    private embedder: Embedder
  ) {}

  /** 写入记忆 */
  async write(memory: Omit<MemoryEntry, 'id' | 'source' | 'createdAt'>): Promise<string> {
    const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date();

    // KV 类型：精确查询的记忆
    if ((memory.type === 'profile' || memory.type === 'preference') && memory.key) {
      await this.kvStore.set(`memory:${memory.userId}:${memory.type}:${memory.key}`, {
        content: memory.content,
        updatedAt: now,
        importance: memory.importance,
      });
    }

    // 所有类型都写入向量库（支持语义检索）
    const embedding = await this.embedder.embed(memory.content);
    await this.vectorStore.upsert({
      id,
      embedding,
      metadata: {
        userId: memory.userId,
        type: memory.type,
        importance: memory.importance,
        createdAt: now,
        lastAccessedAt: now,
      },
      document: memory.content,
    });

    return id;
  }

  /** 精确查询 */
  async getByKey(userId: string, type: string, key: string): Promise<string | null> {
    const entry = await this.kvStore.get(`memory:${userId}:${type}:${key}`);
    return entry?.content || null;
  }

  /** 语义检索 */
  async search(userId: string, query: string, topK: number = 5): Promise<MemorySearchResult[]> {
    const queryEmbedding = await this.embedder.embed(query);
    const results = await this.vectorStore.search(queryEmbedding, {
      filter: { userId },
      topK,
      minScore: 0.7,
    });

    // 更新被召回记忆的 lastAccessedAt
    for (const r of results) {
      await this.touchLastAccessed(r.id);
    }

    return results.map(r => ({
      content: r.document,
      type: r.metadata.type as MemoryType,
      relevance: r.score,
      createdAt: new Date(r.metadata.createdAt),
    }));
  }

  /** 更新记忆的最近访问时间（供衰减机制使用） */
  private async touchLastAccessed(memoryId: string): Promise<void> {
    // 用独立的 KV 存储 lastAccessedAt，避免频繁 re-embed
    // key 格式: memory_access:{memoryId}
    await this.kvStore.set(`memory_access:${memoryId}`, {
      content: new Date().toISOString(),
      updatedAt: new Date(),
      importance: 0,
    });
  }

  /** 获取记忆的最近访问时间 */
  private async getLastAccessedAt(memoryId: string): Promise<Date | null> {
    const entry = await this.kvStore.get(`memory_access:${memoryId}`);
    if (!entry) return null;
    return new Date(entry.content);
  }

  /** 综合召回：先精确查，再语义搜，合并去重 */
  async recall(userId: string, query: string, options?: RecallOptions): Promise<MemoryEntry[]> {
    const results: MemoryEntry[] = [];

    // Step 1: 如果有明确的 key，先精确查
    if (options?.keys) {
      for (const key of options.keys) {
        const value = await this.getByKey(userId, options.type || 'fact', key);
        if (value) {
          results.push({
            id: '',
            userId,
            type: options.type || 'fact',
            key,
            content: value,
            importance: 1,
            source: 'kv',
            createdAt: new Date(),
          });
        }
      }
    }

    // Step 2: 语义检索补充
    const semanticResults = await this.search(userId, query, options?.topK || 5);
    for (const r of semanticResults) {
      // 去重
      if (!results.some(existing => existing.content === r.content)) {
        results.push({
          id: '',
          userId,
          type: r.type,
          content: r.content,
          importance: 0.5,
          source: 'vector',
          relevance: r.relevance,
          createdAt: r.createdAt,
        });
      }
    }

    // Step 3: 按重要性 + 相关性排序
    return results.sort((a, b) => {
      const scoreA = (a.relevance || 1) * (a.importance || 0.5);
      const scoreB = (b.relevance || 1) * (b.importance || 0.5);
      return scoreB - scoreA;
    });
  }

  /** 删除用户的所有记忆（GDPR 合规） */
  async deleteAllMemories(userId: string): Promise<{ deletedCount: number }> {
    let deletedCount = 0;

    // 删除 KV 中的所有记忆
    const kvEntries = await this.kvStore.listByPrefix(`memory:${userId}:`);
    for (const entry of kvEntries) {
      await this.kvStore.delete(entry.key);
      deletedCount++;
    }

    // 删除向量库中的所有记忆
    const vectorEntries = await this.vectorStore.list({ filter: { userId } });
    for (const entry of vectorEntries) {
      await this.vectorStore.delete(entry.id);
      deletedCount++;
    }

    return { deletedCount };
  }

  /** 按内容精确匹配删除记忆（用于冲突覆盖场景） */
  async deleteByContent(userId: string, content: string): Promise<number> {
    const entries = await this.vectorStore.list({ filter: { userId } });
    let deletedCount = 0;
    for (const entry of entries) {
      if (entry.document === content) {
        await this.vectorStore.delete(entry.id);
        await this.kvStore.delete(`memory_access:${entry.id}`);
        deletedCount++;
      }
    }
    return deletedCount;
  }

  /** 将记忆写入待审核队列（用于 human_review 策略） */
  async writePendingReview(
    memory: Omit<MemoryEntry, 'id' | 'source' | 'createdAt'>,
    conflictingContent: string
  ): Promise<void> {
    const pendingKey = `pending_memory:${memory.userId}:${Date.now()}`;
    await this.kvStore.set(pendingKey, {
      content: JSON.stringify({
        newMemory: memory,
        conflictingContent,
        submittedAt: new Date().toISOString(),
      }),
      updatedAt: new Date(),
      importance: 0,
    });
  }
}
```

### 5.4 记忆的遗忘与更新

企业级 Memory 不是只增不减的——**过时的记忆比没有记忆更危险**。

```typescript
interface MemoryLifecyclePolicy {
  /** 记忆的最大存活时间（天） */
  maxAgeDays: number;
  /** 访问衰减因子（每次被召回时重置计时器） */
  accessDecayFactor: number;
  /** 重要性衰减率（每月降低多少） */
  importanceDecayRate: number;
  /** 冲突检测：新记忆与旧记忆矛盾时如何处理 */
  conflictStrategy: 'overwrite' | 'merge' | 'keep_newer' | 'human_review';
}

/** 定期清理过时记忆 */
async function runMemoryMaintenance(
  userId: string,
  policy: MemoryLifecyclePolicy,
  vectorStore: VectorStore,
  kvStore: KVStore
): Promise<{ deletedCount: number; decayedCount: number }> {
  const allMemories = await vectorStore.list({ filter: { userId } });
  const now = Date.now();
  let deletedCount = 0;
  let decayedCount = 0;

  for (const memory of allMemories) {
    const createdAt = new Date(memory.metadata.createdAt);
    const ageDays = (now - createdAt.getTime()) / (1000 * 86400);

    // 从独立 KV 获取 lastAccessedAt
    const accessEntry = await kvStore.get(`memory_access:${memory.id}`);
    const lastAccessedAt = accessEntry ? new Date(accessEntry.content) : createdAt;
    const daysSinceAccess = (now - lastAccessedAt.getTime()) / (1000 * 86400);

    // 条件 1：超过最大存活时间且长时间未被访问
    if (ageDays > policy.maxAgeDays && daysSinceAccess > policy.maxAgeDays / 2) {
      await vectorStore.delete(memory.id);
      await kvStore.delete(`memory_access:${memory.id}`);
      deletedCount++;
      continue;
    }

    // 条件 2：重要性衰减到阈值以下
    const decayedImportance = memory.metadata.importance *
      Math.pow(1 - policy.importanceDecayRate, ageDays / 30);
    if (decayedImportance < 0.1) {
      await vectorStore.delete(memory.id);
      await kvStore.delete(`memory_access:${memory.id}`);
      deletedCount++;
      continue;
    }
  }

  return { deletedCount, decayedCount };
}

/**
 * 记忆冲突检测与处理
 * 当新记忆与已有记忆语义相似但内容矛盾时，按策略处理
 */
async function handleMemoryConflict(
  newMemory: Omit<MemoryEntry, 'id' | 'source' | 'createdAt'>,
  store: LongTermMemoryStore,
  embedder: Embedder,
  llmClient: LLMClient,
  policy: MemoryLifecyclePolicy
): Promise<'written' | 'merged' | 'discarded' | 'pending_review'> {
  // Step 1: 检索语义相似的已有记忆
  const similar = await store.search(newMemory.userId, newMemory.content, 3);
  const conflicting = similar.filter(s => s.relevance > 0.85);

  if (conflicting.length === 0) {
    // 无冲突，直接写入
    await store.write(newMemory);
    return 'written';
  }

  switch (policy.conflictStrategy) {
    case 'overwrite':
      // 删除语义相似的旧记忆，写入新记忆
      for (const old of conflicting) {
        await store.deleteByContent(newMemory.userId, old.content);
      }
      await store.write(newMemory);
      return 'written';

    case 'keep_newer':
      // 只保留更新的记忆（不删除旧的，新记忆优先级更高会在 recall 排序中胜出）
      await store.write(newMemory);
      return 'written';

    case 'merge':
      // 用 LLM 合并新旧记忆
      const mergePrompt = `请将以下两条记忆合并为一条，保留最新的信息，去除过时的部分：
旧记忆: ${conflicting[0].content}
新记忆: ${newMemory.content}
输出合并后的一条记忆（简洁、自包含）：`;
      const mergedContent = await llmClient.generate(mergePrompt);
      // 删除旧记忆，写入合并后的新记忆
      await store.deleteByContent(newMemory.userId, conflicting[0].content);
      await store.write({ ...newMemory, content: mergedContent });
      return 'merged';

    case 'human_review':
      // 写入待审核队列，不自动写入正式记忆库
      await store.writePendingReview(newMemory, conflicting[0].content);
      return 'pending_review';

    default:
      await store.write(newMemory);
      return 'written';
  }
}
```

---

## 六、Layer 4：Knowledge Base（知识库）

### 与 Long-term Memory 的区别

| 维度 | Long-term Memory | Knowledge Base |
|------|-----------------|----------------|
| 归属 | 个人 | 团队/项目 |
| 来源 | AI 自动提取 | 人工维护 + 自动化导入 |
| 更新频率 | 高（每次对话都可能写入） | 低（文档更新时批量导入） |
| 权威性 | 中（可能有误） | 高（经过审核） |
| 典型内容 | 用户偏好、历史经验 | API 文档、架构设计、业务规则 |

### 知识库的构建

这部分本质上就是 **RAG**，参见你已有的 `01-rag-knowledge-base.md`。这里补充企业级特有的考虑：

```typescript
interface KnowledgeBaseConfig {
  /** 数据来源 */
  sources: {
    type: 'yuque' | 'confluence' | 'git' | 'local_docs' | 'api_docs';
    path: string;
    refreshInterval: string;       // '1h' | '1d' | 'manual'
  }[];

  /** 分块策略 */
  chunking: {
    strategy: 'fixed_size' | 'semantic' | 'document_structure';
    maxSize: number;               // 最大 chunk 大小
    overlap: number;               // 重叠大小
  };

  /** 权限控制 */
  accessControl: {
    enabled: boolean;
    defaultPermission: 'read' | 'none';
    documentPermissions?: Record<string, string[]>;  // docId → allowedUserIds
  };

  /** 质量保障 */
  qualityGate: {
    minChunkLength: number;        // 太短的 chunk 丢弃
    deduplication: boolean;        // 去重
    staleDetection: boolean;       // 检测过时内容
  };
}
```

---

## 七、Memory 在 Prompt 中的注入策略

### 不是把所有记忆塞进去，而是按需召回

```typescript
interface MemoryInjectionConfig {
  /** L1: 始终注入（最近对话） */
  buffer: { alwaysInclude: true };

  /** L2: 始终注入（当前任务状态） */
  working: { alwaysInclude: true };

  /** L3: 按需召回（长期记忆） */
  longTerm: {
    autoRecall: true;              // 每轮自动召回相关记忆
    topK: number;                  // 召回条数
    minRelevance: number;          // 最低相关性阈值
    maxTokens: number;             // 记忆部分的 token 上限
  };

  /** L4: 按需召回（知识库） */
  knowledge: {
    triggerKeywords: string[];     // 触发检索的关键词
    topK: number;
    maxTokens: number;
  };
}

// ─── Memory System 聚合类型 ──────────────────────────────────────────────────
interface KnowledgeSearchResult {
  content: string;
  source: string;
}

interface KnowledgeStore {
  search(query: string, options: { topK: number }): Promise<KnowledgeSearchResult[]>;
}

interface MemorySystem {
  buffer: SlidingWindowBuffer;
  working: WorkingMemoryManager;
  longTerm: LongTermMemoryStore;
  knowledge: KnowledgeStore;
}

/** LLM Client 抽象接口（用于摘要、冲突合并等） */
interface LLMClient {
  generate(prompt: string): Promise<string>;
}

/** Token 估算工具（简化版，生产环境应使用 tiktoken） */
function estimateTokens(messages: Message[]): number {
  // 粗略估算：中文约 1.5 token/字，英文约 0.75 token/word
  let total = 0;
  for (const msg of messages) {
    const chineseChars = (msg.content.match(/[\u4e00-\u9fff]/g) || []).length;
    const otherChars = msg.content.length - chineseChars;
    total += Math.ceil(chineseChars * 1.5 + otherChars * 0.3);
  }
  return total;
}

const BASE_SYSTEM_PROMPT = `You are a helpful AI assistant with memory capabilities.
Use the provided memories and context to give personalized, accurate responses.
Do not mention that you have access to memories unless the user asks.`;

/** 组装最终的 Prompt */
async function buildPromptWithMemory(
  userId: string,
  userMessage: string,
  memorySystem: MemorySystem,
  config: MemoryInjectionConfig
): Promise<Message[]> {
  const messages: Message[] = [];

  // System Prompt（固定部分）
  messages.push({ role: 'system', content: BASE_SYSTEM_PROMPT });

  // L3: 召回相关长期记忆
  if (config.longTerm.autoRecall) {
    const longTermMemories = await memorySystem.longTerm.recall(userId, userMessage, {
      topK: config.longTerm.topK,
      minRelevance: config.longTerm.minRelevance,
    });
    if (longTermMemories.length > 0) {
      const memoryText = longTermMemories
        .map(m => `[${m.type}] ${m.content}`)
        .join('\n');
      messages.push({
        role: 'system',
        content: `<user_memories>\n${memoryText}\n</user_memories>`,
      });
    }
  }

  // L4: 知识库检索
  const knowledgeResults = await memorySystem.knowledge.search(userMessage, {
    topK: config.knowledge.topK,
  });
  if (knowledgeResults.length > 0) {
    const knowledgeText = knowledgeResults
      .map(k => `[${k.source}] ${k.content}`)
      .join('\n---\n');
    messages.push({
      role: 'system',
      content: `<knowledge_base>\n${knowledgeText}\n</knowledge_base>`,
    });
  }

  // L2: 工作记忆快照
  const workingSnapshot = memorySystem.working.getSnapshot();
  if (workingSnapshot) {
    messages.push({
      role: 'system',
      content: `<working_memory>\n${workingSnapshot}\n</working_memory>`,
    });
  }

  // L1: 对话缓冲
  messages.push(...memorySystem.buffer.getPromptMessages());

  // 当前用户消息
  messages.push({ role: 'user', content: userMessage });

  return messages;
}
```

### Token 预算分配

```typescript
const TOKEN_BUDGET = {
  systemPrompt: 2000,
  longTermMemory: 3000,
  knowledgeBase: 5000,
  workingMemory: 2000,
  conversationBuffer: 8000,
  reservedForOutput: 4000,
};

/**
 * 超预算时按优先级裁剪消息
 * 降级顺序：知识库 → 长期记忆 → 对话缓冲 → 工作记忆（最后才动）
 */
function enforceTokenBudget(messages: Message[], budget: typeof TOKEN_BUDGET): Message[] {
  const maxInputTokens = 200000 - budget.reservedForOutput;
  let result = [...messages];

  while (estimateTokens(result) > maxInputTokens) {
    // 找到各层级的消息索引范围
    const knowledgeIdx = result.findIndex(m => m.content.startsWith('<knowledge_base>'));
    const memoryIdx = result.findIndex(m => m.content.startsWith('<user_memories>'));
    const summaryIdx = result.findIndex(m => m.content.startsWith('[Previous conversation summary]'));
    const workingIdx = result.findIndex(m => m.content.startsWith('<working_memory>'));

    // 降级 1: 移除知识库
    if (knowledgeIdx !== -1) {
      result.splice(knowledgeIdx, 1);
      continue;
    }

    // 降级 2: 移除长期记忆
    if (memoryIdx !== -1) {
      result.splice(memoryIdx, 1);
      continue;
    }

    // 降级 3: 移除对话摘要（最早的上下文）
    if (summaryIdx !== -1) {
      result.splice(summaryIdx, 1);
      continue;
    }

    // 降级 4: 移除最早的非 system 对话消息
    const firstUserMsgIdx = result.findIndex(m => m.role === 'user' || m.role === 'assistant');
    if (firstUserMsgIdx !== -1) {
      result.splice(firstUserMsgIdx, 1);
      continue;
    }

    // 降级 5: 移除工作记忆（最后手段）
    if (workingIdx !== -1) {
      result.splice(workingIdx, 1);
      continue;
    }

    // 无法再裁剪，跳出避免死循环
    break;
  }

  return result;
}
```

---

## 八、企业级 Memory 的安全与合规

### 必须考虑的安全问题

| 风险 | 解决方案 |
|------|---------|
| **记忆泄露**：用户 A 的记忆被用户 B 召回 | 所有记忆带 userId 隔离，检索时强制过滤 |
| **敏感信息入记忆**：密码、token、个人信息被存入 | 写入前做 PII 检测 + 正则过滤 |
| **记忆投毒**：恶意用户故意写入错误记忆 | 重要性评分 + 人工审核机制 |
| **GDPR/合规**：用户要求删除所有记忆 | 提供 `deleteAllMemories(userId)` API |
| **记忆过期**：离职员工的记忆仍被使用 | TTL + 定期清理 + 账号状态联动 |

```typescript
/** PII 检测结果 */
interface PIIDetectionResult {
  hasPII: boolean;
  types: string[];
  sanitizedContent: string;         // 脱敏后的内容
}

/** PII 检测 + 脱敏：写入前过滤敏感信息 */
function detectAndSanitizePII(content: string): PIIDetectionResult {
  const patterns: { type: string; regex: RegExp; replacement: string }[] = [
    { type: 'email', regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: '[EMAIL_REDACTED]' },
    { type: 'phone', regex: /\+?\d{10,15}/g, replacement: '[PHONE_REDACTED]' },
    { type: 'id_card', regex: /\d{17}[\dXx]/g, replacement: '[ID_CARD_REDACTED]' },
    { type: 'api_key', regex: /(?:sk-|ak_|token_)[a-zA-Z0-9]{20,}/g, replacement: '[API_KEY_REDACTED]' },
    { type: 'password', regex: /(?:password|passwd|pwd)\s*[:=]\s*\S+/gi, replacement: '[PASSWORD_REDACTED]' },
    { type: 'private_key', regex: /-----BEGIN\s+(RSA\s+)?PRIVATE\sKEY-----[\s\S]*?-----END/g, replacement: '[PRIVATE_KEY_REDACTED]' },
    { type: 'connection_string', regex: /(?:mongodb|mysql|postgres|redis):\/\/[^\s]+/gi, replacement: '[CONN_STRING_REDACTED]' },
  ];

  const detectedTypes: string[] = [];
  let sanitized = content;

  for (const pattern of patterns) {
    if (pattern.regex.test(sanitized)) {
      detectedTypes.push(pattern.type);
      sanitized = sanitized.replace(pattern.regex, pattern.replacement);
    }
  }

  return {
    hasPII: detectedTypes.length > 0,
    types: detectedTypes,
    sanitizedContent: sanitized,
  };
}

/**
 * 记忆写入前的安全网关
 * 根据 PII 检测结果决定：拒绝、脱敏后写入、或告警后写入
 */
type PIIAction = 'reject' | 'sanitize' | 'warn_and_write';

function evaluatePIIAction(detection: PIIDetectionResult): { action: PIIAction; reason: string } {
  // 高危类型：直接拒绝
  const highRiskTypes = ['password', 'private_key', 'api_key', 'connection_string'];
  const hasHighRisk = detection.types.some(t => highRiskTypes.includes(t));

  if (hasHighRisk) {
    return {
      action: 'reject',
      reason: `检测到高危敏感信息: ${detection.types.filter(t => highRiskTypes.includes(t)).join(', ')}，拒绝写入`,
    };
  }

  // 中危类型：脱敏后写入
  const mediumRiskTypes = ['email', 'phone', 'id_card'];
  const hasMediumRisk = detection.types.some(t => mediumRiskTypes.includes(t));

  if (hasMediumRisk) {
    return {
      action: 'sanitize',
      reason: `检测到中危敏感信息: ${detection.types.filter(t => mediumRiskTypes.includes(t)).join(', ')}，已自动脱敏`,
    };
  }

  // 无 PII
  return { action: 'warn_and_write', reason: '未检测到敏感信息' };
}

/**
 * 安全的记忆写入流程（整合 PII 检测 + 冲突处理）
 */
async function safeWriteMemory(
  memory: Omit<MemoryEntry, 'id' | 'source' | 'createdAt'>,
  store: LongTermMemoryStore,
  embedder: Embedder,
  llmClient: LLMClient,
  lifecyclePolicy: MemoryLifecyclePolicy,
  logger: { warn: (msg: string) => void; error: (msg: string) => void }
): Promise<{ status: 'written' | 'merged' | 'sanitized' | 'rejected' | 'pending_review'; detail: string }> {
  // Step 1: PII 检测
  const piiResult = detectAndSanitizePII(memory.content);
  const piiAction = evaluatePIIAction(piiResult);

  if (piiAction.action === 'reject') {
    logger.error(`Memory write rejected for user ${memory.userId}: ${piiAction.reason}`);
    return { status: 'rejected', detail: piiAction.reason };
  }

  // 如果需要脱敏，替换内容
  const finalContent = piiAction.action === 'sanitize' ? piiResult.sanitizedContent : memory.content;
  const finalMemory = { ...memory, content: finalContent };

  if (piiAction.action === 'sanitize') {
    logger.warn(`Memory sanitized for user ${memory.userId}: ${piiAction.reason}`);
  }

  // Step 2: 冲突检测与处理
  const conflictResult = await handleMemoryConflict(finalMemory, store, embedder, llmClient, lifecyclePolicy);

  return {
    status: piiAction.action === 'sanitize' ? 'sanitized' : conflictResult,
    detail: piiAction.action === 'sanitize'
      ? `${piiAction.reason}; conflict: ${conflictResult}`
      : `conflict: ${conflictResult}`,
  };
}
```

---

## 九、行业标杆参考

| 产品 | Memory 特点 | 值得学习的点 |
|------|-----------|-------------|
| **ChatGPT Memory** | 用户可编辑的记忆列表，显式确认 | 透明度：让用户看到和控制记忆 |
| **Claude Projects** | 项目级知识库 + 对话记忆 | L3/L4 分离的设计 |
| **Cursor** | 代码库索引 + 对话历史 + .cursorrules | Working Memory 做得极好 |
| **Devin** | 完整的任务状态持久化 + 文件系统作为记忆 | 用文件系统代替向量库 |
| **Mem0** | 开源 Memory 层，自动提取 + 去重 + 更新 | 记忆写入的自动化流程 |
| **LangMem** | LangChain 官方 Memory SDK | 与 LangGraph 集成的最佳实践 |

---

## 十、在你的 simple-agent 项目中落地

### 最小可用方案

```
Week 1: L1 Buffer + L2 Working Memory
  → 滑动窗口 + 任务状态持久化
  → 解决"做到一半忘了"的问题

Week 2: L3 Long-term Memory 基础
  → KV Store 存用户偏好
  → 向量库存事实和反馈
  → 解决"每次都要重新了解用户"的问题

Week 3: Memory 注入 + Token 预算管理
  → 按需召回，不爆 token
  → 记忆写入的 LLM 判断

Week 4: 安全 + 维护 + 评测
  → PII 过滤、用户隔离
  → 记忆质量评测（召回准确率）
```

---

## 十一、一句话总结

> **企业级 Memory = 分层存储 + 智能筛选 + 按需召回 + 安全合规 + 持续维护。**
> 它不是一个功能，而是一个**子系统**。做好它，你的 Agent 就从"工具"变成了"同事"。

---

## 下一步

卷七到此收官。接下来进入**卷八 · Agent 互操作协议**：当你的 Agent 已经足够可靠、也有记忆了，它如何与**别的 Agent**、与**编辑器/客户端**协作？

- [ ] **第47课：A2A 协议** — 不同厂商的 Agent 怎么互相发现和协作？

> 附录中的 [Agent 架构七题（附录 A1）](/blog/from-scratch-appendix-01-streaming/) 是把本专栏知识点压缩成速答卡，适合在读完正文后按 A1→A7 顺序自测。
