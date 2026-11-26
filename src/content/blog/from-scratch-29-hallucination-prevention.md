---
title: "幻觉防治 — 在 Agent 层面系统性杜绝幻觉"
date: 2026-11-25
excerpt: "如何在架构层面系统性切断幻觉传播链？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 30
---

> 目标：理解 Agent 幻觉的本质与分类，掌握在架构层面系统性防治幻觉的核心手段

> **本卷导览（卷六 · 生产级质量保障）**：前一课我们把能力收敛成了 SDK，本轮开始解决"让它**可靠**"的问题。卷六是一个**并列专题集**——幻觉防治、真流式、成本、重试、可观测、Prompt 版本、并发、测试、多模态、断点续传、Evals，每一课都针对生产环境的一类具体风险，彼此不作为前置依赖，可按需跳读；若按顺序读，建议带着"我的 Agent 上生产还差哪一环"的视角，边读边对照。每篇结尾的「与其他课程的关联」就是坐标，方便你按主题跳转。

---

## 背景：Agent 的幻觉比普通 LLM 更危险

普通 LLM 的幻觉顶多是"说错了"，但 Agent 的幻觉会**直接驱动错误行为**：

- 模型"以为"某个文件存在 → 调用 `read_file` → 工具报错 → 模型假装成功继续执行
- 模型"记得"某个 API 的参数格式 → 生成错误的调用代码 → 用户拿去用，运行报错
- 模型"觉得"任务已完成 → 跳过关键步骤 → 输出残缺结果

**幻觉在 Agent 里会被放大和传播**，因为每一步的错误都会成为下一步的输入。

---

## 幻觉的两大根源

```
幻觉
├── 知识型幻觉：模型用训练数据里的"记忆"代替真实世界的事实
│   └── 例：凭记忆说某个 npm 包的 API，但版本已经变了
│
└── 执行型幻觉：模型忽略工具的真实返回结果，用自己的"预期"作答
    └── 例：工具返回了错误，模型却继续假装工具成功了
```

---

## 防治手段一：工具优先原则（最根本）

**让模型"不得不"用工具获取信息，而不是凭记忆回答。**

在 System Prompt 中明确约束：

```typescript
const ANTI_HALLUCINATION_SYSTEM_PROMPT = `
你是一个严谨的代码助手。你必须遵守以下规则：

1. 任何关于文件内容的陈述，必须先调用 read_file 工具读取后再回答
2. 任何关于目录结构的陈述，必须先调用 list_dir 工具确认后再回答
3. 任何关于代码逻辑的陈述，必须基于你实际读取到的代码，而非你的记忆
4. 严禁使用"可能"、"通常"、"一般来说"来回答关于当前项目的具体问题
5. 如果你不确定某个事实，必须调用工具确认，严禁猜测
`.trim();
```

这个原则的本质是：**把"我认为"变成"工具告诉我"**。

---

## 防治手段二：结果强制注入上下文（闭环验证）

**工具执行结果必须回写到 messages 里，让模型"看到"真实结果后再作答。**

这是 Agent Loop 的核心设计，也是防治执行型幻觉的关键：

```
用户消息
    │
    ▼
模型决策：调用哪个工具、传什么参数
    │
    ▼
工具实际执行（真实 I/O）
    │
    ▼
结果作为 tool_result 消息追加到 messages
    │
    ▼
模型基于真实结果生成回答  ← 幻觉在这里被切断
```

**关键约束**：模型的最终回答必须在看到 `tool_result` 之后才生成，绝不能在工具调用之前就输出结论。

```typescript
// ✅ 正确：工具结果回写后，模型才能继续
messages.push({
  role: 'tool',
  tool_call_id: toolCall.id,
  content: JSON.stringify(toolResult),  // 真实结果，不能省略
});

// 继续让模型基于真实结果作答
const nextResponse = await llm.chat(messages);
```

---

## 防治手段三：错误透明化（不掩盖失败）

**幻觉最容易在错误处理时产生**——工具失败了，模型却假装成功继续。

```typescript
// ❌ 错误做法：捕获错误后用空值继续，模型会基于空结果产生幻觉
async function readFileSafe(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return '';  // 危险！模型不知道文件读取失败了
  }
}

// ✅ 正确做法：把错误明确告知模型，让它重新规划
async function readFileSafe(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    // 返回结构化的错误信息，让模型知道发生了什么
    return JSON.stringify({
      error: true,
      message: `文件读取失败: ${(error as Error).message}`,
      suggestion: '请确认文件路径是否正确，或先用 list_dir 查看目录结构',
    });
  }
}
```

错误信息要足够具体，让模型能据此**重新规划**，而不是继续在错误的假设上执行。

---

## 防治手段四：ReAct 模式（思考-行动-观察循环）

强制模型在每次行动前**显式推理**，在行动后**显式观察**，让每一步都有据可查：

```
Thought: 用户问的是 src/agent.ts 里的逻辑，我不能假设，必须先读取文件
Action: read_file("src/agent.ts")
Observation: [文件实际内容...]
Thought: 基于我刚才读到的第 42 行代码，可以看出...
Answer: 根据 src/agent.ts 第 42 行的实现...
```

在 System Prompt 中强制要求这个格式：

```typescript
const REACT_SYSTEM_PROMPT = `
在回答任何关于代码的问题前，你必须按照以下格式思考：

Thought: [我需要什么信息？我能假设吗？还是必须用工具获取？]
Action: [调用什么工具]
Observation: [工具返回了什么]
Thought: [基于真实观察，我现在可以得出什么结论？]
Answer: [基于以上观察的回答，并引用具体的工具返回内容]
`.trim();
```

ReAct 模式让幻觉**无处遁形**——因为每一步推理都有对应的真实观察支撑。

---

## 防治手段五：引用溯源（Grounding）

要求模型回答时**必须引用具体的工具返回内容**，而不是泛泛而谈：

```typescript
const GROUNDING_PROMPT = `
当你基于工具结果作答时，必须明确引用来源，例如：
- "根据 read_file 返回的第 23 行代码..."
- "list_dir 显示该目录下有以下文件..."
- "工具返回的错误信息是：..."

严禁使用以下表述来回答关于当前项目的具体问题：
- "通常情况下..."
- "一般来说..."
- "这个框架一般会..."
`.trim();
```

---

## 防治手段六：结构化输出校验

对于关键决策，要求模型输出结构化 JSON，然后在程序层面校验合理性：

```typescript
import { generateObject } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';

const ToolCallDecisionSchema = z.object({
  reasoning: z.string().describe('为什么要调用这个工具，基于什么已知信息'),
  tool_name: z.string().describe('要调用的工具名'),
  parameters: z.record(z.unknown()).describe('工具参数'),
  confidence: z.number().min(0).max(1).describe('对参数正确性的置信度'),
  needs_verification: z.boolean().describe('执行前是否需要先验证前提条件'),
});

const provider = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const model = provider.chat('gpt-4');

// 让模型以结构化方式决策下一步工具调用
const { object: decision } = await generateObject({
  model,
  schema: ToolCallDecisionSchema,
  messages: [
    {
      role: 'system',
      content: '你是一个严谨的任务规划者，在调用工具前必须明确说明理由和置信度。',
    },
    {
      role: 'user',
      content: `当前任务：读取并分析 src/agent.ts 文件的结构。请决定下一步应该调用哪个工具。`,
    },
  ],
});

// 程序层面校验：低置信度时，强制先用轻量工具验证前提条件
if (decision.confidence < 0.8 || decision.needs_verification) {
  console.log(`⚠️ 置信度 ${decision.confidence}，先验证前提条件再执行`);
  // 例如：先确认文件存在，再调用 read_file
  // 例如：先确认权限，再调用 write_file
}

console.log(`✅ 决策理由：${decision.reasoning}`);
console.log(`📦 准备调用：${decision.tool_name}，参数：${JSON.stringify(decision.parameters)}`);
```

---

## 防治手段七：自我校验（Self-Check）

在 Agent 循环里加入**验证步骤**，让模型在执行后确认结果符合预期：

```typescript
import { generateObject } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';

const VerificationSchema = z.object({
  matches_intent: z.boolean().describe('工具结果是否符合原始意图'),
  issue: z.string().optional().describe('如果不符合，具体问题是什么'),
  should_retry: z.boolean().describe('是否需要重新规划'),
});

// 注意：model 在 Agent 类中是 private 的，自我校验应在 Agent 内部方法中实现，
// 或通过构造时传入的 model 参数单独持有一个校验用的 model 实例
async function verifyToolResult(
  model: ReturnType<ReturnType<typeof createOpenAI>['chat']>,
  toolName: string,
  toolResult: unknown,
  originalIntent: string,
): Promise<{ verified: boolean; issue?: string }> {
  const { object: verification } = await generateObject({
    model,
    schema: VerificationSchema,
    messages: [
      {
        role: 'system',
        content: '你是一个严格的结果校验者，判断工具执行结果是否真正满足了原始意图。',
      },
      {
        role: 'user',
        content: `原始意图：${originalIntent}\n工具名称：${toolName}\n工具返回：${JSON.stringify(toolResult)}\n\n请判断：工具的返回结果是否符合原始意图？`,
      },
    ],
  });

  return {
    verified: verification.matches_intent,
    issue: verification.issue,
  };
}

// 使用示例：在 Agent Loop 的工具执行后调用
const provider = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const verifyModel = provider.chat('gpt-4');

const toolResult = await someToolExecution();
const { verified, issue } = await verifyToolResult(
  verifyModel,
  'read_file',
  toolResult,
  '读取 src/agent.ts 并获取 Agent 类的构造函数参数列表',
);

if (!verified) {
  console.warn(`⚠️ 工具结果与预期不符：${issue}，重新规划...`);
  // 将问题反馈给模型，触发重新规划
}
```

---

## 各手段对照表

| 手段 | 解决的幻觉类型 | 实现成本 | 效果 |
|------|--------------|----------|------|
| **工具优先原则** | 知识型幻觉（凭记忆捏造事实） | 低（System Prompt） | ⭐⭐⭐⭐⭐ |
| **结果强制注入** | 执行型幻觉（忽略工具真实结果） | 低（架构设计） | ⭐⭐⭐⭐⭐ |
| **错误透明化** | 失败时的假装成功 | 低（错误处理规范） | ⭐⭐⭐⭐ |
| **ReAct 模式** | 跳过观察直接结论 | 中（Prompt 工程） | ⭐⭐⭐⭐ |
| **引用溯源** | 泛泛而谈、无据可查 | 低（Prompt 约束） | ⭐⭐⭐ |
| **结构化输出校验** | 关键决策的参数错误 | 中（Schema 设计） | ⭐⭐⭐ |
| **自我校验** | 工具结果误解 | 高（额外 LLM 调用） | ⭐⭐⭐ |

**优先级建议**：先实现前三个（成本低、效果好），再按需叠加后四个。

---

## 知识点总结

| 概念 | 说明 |
|------|------|
| **知识型幻觉** | 模型用训练数据里的"记忆"代替真实世界的事实 |
| **执行型幻觉** | 模型忽略工具的真实返回结果，用自己的"预期"作答 |
| **工具优先原则** | 通过 System Prompt 约束，强制模型用工具获取信息而非猜测 |
| **闭环验证** | 工具结果必须回写到 messages，模型基于真实结果作答 |
| **错误透明化** | 工具失败时返回结构化错误信息，而非空值或假装成功 |
| **ReAct 模式** | Thought → Action → Observation 循环，每步有据可查 |
| **Grounding** | 要求模型引用具体的工具返回内容，而非泛泛而谈 |

---

## 与其他课程的关联

- **第19课（Reflection）**：Critic-Actor 循环本质上是一种结构化的自我校验，可以与本课的手段七组合使用——用外部 Critic 对 Agent 每步输出进行质量评审，进一步降低幻觉传播的风险
- **第20课（Planning）**：在规划阶段提前识别哪些步骤依赖外部事实（文件内容、API 返回等），并标记为"必须用工具验证"，是在任务开始前就切断幻觉的最前置防线
