---
title: "第十七课：Structured Output — 结构化输出"
date: 2026-11-25
excerpt: "如何让 LLM 稳定输出符合 JSON Schema 的数据？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 18
---

> 目标：按「从底层到封装」的递进阶梯，理解结构化输出的完整技术栈——
> 采样层约束 → 生成后解析 → 厂商 API 强制 → SDK 封装。
> 学完你能回答：LLM 凭什么能保证输出合法 JSON？每一层各保证到什么程度？

---

## 背景：LLM 默认不输出 JSON，这不是玄学

普通 `generateText` 返回的是自由文字：

```
"用户名是张三，年龄 28 岁，职业是前端工程师。"
```

要入库、给下游 API，就得手动解析，脆弱又麻烦。期望的是直接得到：

```json
{ "name": "张三", "age": 28, "role": "frontend_engineer" }
```

**核心前提（贯穿全课）**：LLM 的输出**本质是一个 token 序列**，它没有任何"必须是合法 JSON"的天赋。所谓"结构化输出"，就是下面这整条技术栈，用不同的强度去**保证/逼近**"输出是合法且符合 schema 的 JSON"。

```
递进：L0 采样层 → L1 生成后解析 → L2 厂商 API 层 → L3 SDK 封装层
      (约束解码)   (parse+重试)   (response_format/工具)  (generateObject+Zod)
      保证最强 ◀───────────────────────────────▶ 最省事
```

---

## L0 采样层：约束解码（最底层）

既然 LLM 是"逐 token 采样"，那最直接的反制是——**在采样那一刻就不允许非法 token 生成**。

```
正常采样：
  LLM 给出候选 token 及概率： '"'(0.7)  'n'(0.2)  '\\'(0.1)
  随机/贪心选一个 → 可能选到 'n' → 输出变成 "n..." → 非法 JSON ✗

约束解码(grammar/guided decoding)：
  用一个表示"合法JSON"的 grammar(FSA/CFG) 生成 token 掩码
  → 把 'n'、'\\' 从候选中剔除 → 只能在 { '"' } 里选 → 必然合法 ✓
```

- **代表实现**：vLLM `guided_json`、Outlines、llama.cpp `GBNF`、JSONFormer；通用语法约束有 GrammarKit 等。
- **优点**：非法 token 根本出不来，保证最强。
- **缺点**：需要推理框架级支持（自建/本地部署才行，云 API 多数不开放采样层）；强约束会牺牲一点自由度；可观测性被 grammar 挡了一层。

> 面试点：拿"采样层约束 vs API 层强制"区分——两者都"强制"，但一个发生在**token 生成时**，一个发生在**服务端响应时**。

---

## L1 生成后解析 + 重试（最朴素，保证最弱）

约束解码用不上时，最朴素的做法：**先让它生成，再解析，失败就重试/纠错**。

```typescript
import { generateText } from 'ai';

async function askJSON(prompt: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { text } = await generateText({
      model,
      messages: [
        { role: 'system', content: '你必须只输出合法 JSON，不要代码块、注释或多余文字。' },
        { role: 'user', content: prompt },
      ],
    });
    const cleaned = text.replace(/^```json|```$/g, '').trim(); // 剥掉 ```json``` 围栏
    try {
      return JSON.parse(cleaned); // 解析成功 → 返回
    } catch {
      // 解析失败 → 把错误回喂给模型，让它修正
    }
  }
  throw new Error('多次尝试仍无法得到合法 JSON');
}
```

- **保证**：只在"统计上大概率合法"层面，**不保证**类型/必填字段。
- 优：零依赖、任何模型/服务都可用；缺：慢、费 token、仍可能失败。
- 这是"JSON Mode 提示词约束"的完整形态——**提示词 + 事后解析 + 失败重试**。

---

## L2 厂商 API 层：让"服务器"替你保证（本课重点）

这是真正把"保证"从客户端搬到**服务端**的一层——你要么用 `response_format`，要么用 Function Calling 强制。

### 2.1 OpenAI：JSON Mode vs Structured Outputs（必须分清）

**JSON Mode** —— `response_format: { "type": "json_object" }`

```http
POST /v1/chat/completions
{
  "model": "gpt-4o",
  "response_format": { "type": "json_object" },
  "messages": [
    { "role": "system", "content": "输出合法 JSON。输出 JSON 对象。" },
    { "role": "user", "content": "提取：张三，28岁，前端" }
  ]
}
```

- 只保证**输出是合法 JSON**（无 ```` ``` ```` 围栏、无注释），**不保证**符合你定义的 schema。
- 仍需 prompt 配合；某些模型/流式场景限制多。

**Structured Outputs** —— `response_format: { "type": "json_schema", ... }`

```http
POST /v1/chat/completions
{
  "model": "gpt-4o",
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "user_info",
      "strict": true,
      "schema": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "age":  { "type": "integer" }
        },
        "required": ["name", "age"],
        "additionalProperties": false
      }
    }
  },
  "messages": [...]
}
```

- 上传 JSON Schema，**服务端强制输出符合该 schema**（server-side enforcement）。
- `strict: true` 时：所有字段必填、`additionalProperties: false`（不许多出字段）。
- 这是生产里"真结构化"的默认选择。

| | JSON Mode | Structured Outputs |
|---|---|---|
| 保证 | 只是合法 JSON | **符合你的 JSON Schema** |
| schema | 无 | 上传并强制 |
| 生产推荐 | ⚠️ | ✅ |

### 2.2 Anthropic（Claude）—— 同思路

```http
POST /v1/messages
{
  "model": "claude-sonnet-...",
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "user_info",
      "schema": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "age":  { "type": "integer" }
        },
        "required": ["name", "age"]
      }
    }
  },
  "messages": [...]
}
```

> 各家叫法不同、字段略异，但**设计同一**：在请求里给一个 JSON Schema，服务端保证响应符合它。

### 2.3 Function Calling / tool_choice：把"输出"伪装成"工具参数"

这是 `generateObject` 底层走的另一条强制通道——**不给模型"逃脱到自由文字"的机会**：

```jsonc
{
  "tools": [{
    "type": "function",
    "function": {
      "name": "extract_data",
      "parameters": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "age":  { "type": "integer" }
        },
        "required": ["name", "age"]
      }
    }
  }],
  "tool_choice": { "type": "function", "function": { "name": "extract_data" } }
  //                                  ↑ 强制它只能选这个"工具"
}
```

模型只能把结果放进 `extract_data` 的参数 `arguments` 里，而这个 `arguments` 的结构由 `parameters`（一个 JSON Schema）约束 → 结构化输出。

> L2 小结：**`response_format`(json_schema / json_object) 与 Function Calling** 是"服务端强制"的两大入口。SDK 封装层（L3）其实是替你选其中一条并做好校验。

---

## L3 SDK 封装层：generateObject + Zod（最省事）

`ai` SDK 的 `generateObject` 把上面整条都收进一个 API——**你只写 Zod Schema**：

```typescript
import { generateObject } from 'ai';
import { z } from 'zod';

const UserSchema = z.object({
  name: z.string().describe('用户姓名'),
  age: z.number().int().min(0).max(150).describe('用户年龄'),
  role: z.enum(['frontend_engineer', 'backend_engineer', 'designer', 'pm'])
    .describe('用户职业'),
  skills: z.array(z.string()).describe('技能列表'),
});

const { object } = await generateObject({
  model,
  schema: UserSchema,          // ① zod → 自动转 JSON Schema
  prompt: '提取用户信息：张三，28岁，前端工程师，擅长 React 和 TypeScript',
});
// ② 走 L2 的强制通道发给模型
// ③ 结果在本地再做一次校验/重试
// ④ object 已是类型安全：object.name: string, object.skills: string[]
```

**SDK 在背后替你做的四件事**：`Zod → JSON Schema 转换` → `拼装并调用 L2 强制 API` → `解析 + 校验 + 失败自动重试` → `推导出 TypeScript 类型`。

### streamObject：流式结构化输出

大型结构化数据可以边生成边消费，实时渲染不干等：

```typescript
const { partialObjectStream } = streamObject({
  model,
  schema: UserSchema,
  prompt: `提取简历信息：...`,
});

for await (const partialObject of partialObjectStream) {
  console.log('当前进度：', partialObject); // 每生成一个字段触发一次
}
```

---

## 使用场景

### 场景一：信息提取

```typescript
const ResumeSchema = z.object({
  name: z.string(),
  email: z.string().email().optional(),
  experience_years: z.number(),
  skills: z.array(z.string()),
  education: z.object({
    degree: z.string(),
    school: z.string(),
  }).optional(),
});

const { object: resume } = await generateObject({
  model,
  schema: ResumeSchema,
  prompt: `从以下简历文本中提取结构化信息：\n\n${resumeText}`,
});
```

### 场景二：Agent 决策输出

```typescript
const TaskPlanSchema = z.object({
  tasks: z.array(z.object({
    id: z.string(),
    description: z.string(),
    tool: z.enum(['read_file', 'list_files', 'get_current_time']),
    args: z.record(z.string()),
    depends_on: z.array(z.string()).describe('依赖的任务 ID'),
  })),
  estimated_steps: z.number(),
});

const { object: plan } = await generateObject({
  model,
  schema: TaskPlanSchema,
  prompt: `为以下任务制定执行计划：${userRequest}`,
});
```

### 场景三：内容分类

```typescript
const ClassificationSchema = z.object({
  category: z.enum(['bug', 'feature', 'question', 'spam']),
  priority: z.enum(['low', 'medium', 'high', 'critical']),
  confidence: z.number().min(0).max(1).describe('分类置信度 0-1'),
  reason: z.string().describe('分类理由'),
});

const { object } = await generateObject({
  model,
  schema: ClassificationSchema,
  prompt: `对以下 Issue 进行分类：\n\n${issueContent}`,
});
```

---

## Zod Schema 设计技巧

```typescript
z.object({
  // 用 .describe() 给每个字段加说明，帮助模型理解字段含义
  name: z.string().describe('用户的真实姓名，不是昵称'),

  // 用 .optional() 标记可选字段，模型不确定时可以不填
  phone: z.string().optional(),

  // 用 .enum() 限制枚举值，防止模型自由发挥
  status: z.enum(['active', 'inactive', 'pending']),

  // 用 .min()/.max() 约束数值范围
  score: z.number().min(0).max(100),

  // 嵌套对象
  address: z.object({
    city: z.string(),
    country: z.string().default('China'),
  }),

  // 数组
  tags: z.array(z.string()).max(10).describe('最多 10 个标签'),
});
```

---

## 选型权衡表

| 层 | 保证强度 | 实现成本 | 适用 |
|----|---------|---------|------|
| **L0 约束解码** | 最强（token 级） | 高（需推理框架） | 自建推理、本地部署 |
| **L1 生成后解析+重试** | 弱（统计） | 低（零依赖） | 兜底、任何模型 |
| **L2 服务端 response_format / 工具** | 强（schema 级） | 中（改请求体） | 生产默认 |
| **L3 SDK 封装(generateObject+Zod)** | 强 + 类型安全 | 最低（写 Zod） | 前端/应用开发 |

---

## 知识点总结

| 概念 | 说明 |
|------|------|
| **约束解码** | L0 采样层用 grammar 掩码剔除非法 token，保证最强 |
| **JSON Mode** | L2 的 `response_format: json_object`，只保证合法 JSON，不保证 schema |
| **Structured Outputs** | L2 的 `response_format: json_schema`，上传 schema，服务端强制 |
| **Function Calling** | L2 另一条强制通道：把输出当"工具参数"，模型无法逃脱自由文字 |
| **generateObject** | L3 `ai` SDK 封装，Zod → JSON Schema → 强制通道 → 校验重试 → 类型 |
| **Zod Schema** | TS 运行时校验库，同时当作 JSON Schema 的描述语言 |
| **streamObject** | 流式结构化输出，大型数据实时渲染 |
| **.describe()** | 给字段加说明，提升模型理解与准确率 |

---

## 下一步

- [ ] 实现 RAG（检索增强生成），让 Agent 能回答私有知识库里的问题