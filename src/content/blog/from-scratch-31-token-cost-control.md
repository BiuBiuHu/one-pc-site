---
title: "第三十一课：Token 成本控制 — 量化消耗、设定预算、防止超支"
date: 2026-11-25
excerpt: "如何量化消耗、设预算、防账单爆炸？"
category: Agent 开发
lang: zh
series: 从零手搓 AI Agent
seriesOrder: 32
---

> 目标：理解 Token 计费模型，掌握在 Agent 中追踪、限制、优化 Token 消耗的工程手段

---

## 背景：为什么 Token 成本是生产级 Agent 的核心问题

一个没有成本控制的 Agent 在生产环境中是危险的：

- 用户发一条消息，Agent 触发 10 次工具调用，每次都把完整上下文带上 → 单次请求消耗数万 Token
- 某个 Bug 导致 Agent 进入死循环，maxSteps 没有兜底 → 账单爆炸
- 没有 Token 追踪，不知道哪个功能最贵，无法优化

**Token 是 Agent 的"燃料"，必须像管理内存一样管理它。**

---

## Token 计费模型

OpenAI 的计费公式：

```
费用 = (promptTokens × 输入单价 + completionTokens × 输出单价) / 1000
```

以 GPT-4o 为例（2024年价格）：
- 输入：$2.50 / 1M tokens
- 输出：$10.00 / 1M tokens

**输出 token 比输入贵 4 倍**，这意味着：
- 让模型生成长篇大论比读取长上下文更贵
- 减少不必要的输出（如冗余解释）比压缩输入更有价值

---

## 第一步：从 SDK 获取真实 Token 消耗

Vercel ai SDK 在每次调用后都会返回 `usage`，包含 `promptTokens` 和 `completionTokens`：

```typescript
import { generateText, streamText, type LanguageModelUsage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

const provider = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const model = provider.chat('gpt-4o');

// generateText：从返回值直接拿 usage
const { text, usage } = await generateText({
  model,
  messages: [{ role: 'user', content: '解释一下什么是 Agent' }],
});

console.log(`提示词 Token：${usage.promptTokens}`);
console.log(`输出 Token：${usage.completionTokens}`);
console.log(`总计 Token：${usage.promptTokens + usage.completionTokens}`);

// streamText：从 onStepFinish 或 usage Promise 获取
const streamResult = streamText({
  model,
  messages: [{ role: 'user', content: '解释一下什么是 Agent' }],
  onStepFinish: ({ usage: stepUsage }) => {
    console.log(`本步骤消耗：prompt=${stepUsage.promptTokens}, completion=${stepUsage.completionTokens}`);
  },
});

// 等待流结束后获取总 usage
const finalUsage: LanguageModelUsage = await streamResult.usage;
console.log(`总计：prompt=${finalUsage.promptTokens}, completion=${finalUsage.completionTokens}`);
```

---

## 第二步：构建 Token 追踪器

把每次调用的 Token 消耗聚合起来，按会话、按工具、按用户维度统计：

```typescript
import type { LanguageModelUsage } from 'ai';

interface TokenRecord {
  timestamp: number;
  sessionId: string;
  operation: string;       // 'chat' | 'tool_call' | 'compress' 等
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
}

// 各模型的 Token 单价（USD / 1M tokens）
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o':       { input: 2.50,  output: 10.00 },
  'gpt-4o-mini':  { input: 0.15,  output: 0.60  },
  'gpt-4':        { input: 30.00, output: 60.00 },
  'gpt-3.5-turbo':{ input: 0.50,  output: 1.50  },
};

export class TokenTracker {
  private records: TokenRecord[] = [];
  private modelName: string;

  constructor(modelName: string) {
    this.modelName = modelName;
  }

  record(sessionId: string, operation: string, usage: LanguageModelUsage): void {
    const pricing = MODEL_PRICING[this.modelName] ?? { input: 0, output: 0 };
    const estimatedCostUsd =
      (usage.promptTokens * pricing.input + usage.completionTokens * pricing.output) / 1_000_000;

    this.records.push({
      timestamp: Date.now(),
      sessionId,
      operation,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      estimatedCostUsd,
    });
  }

  // 获取指定会话的累计消耗
  getSessionSummary(sessionId: string): {
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalCostUsd: number;
    callCount: number;
  } {
    const sessionRecords = this.records.filter((record) => record.sessionId === sessionId);
    return {
      totalPromptTokens: sessionRecords.reduce((sum, record) => sum + record.promptTokens, 0),
      totalCompletionTokens: sessionRecords.reduce((sum, record) => sum + record.completionTokens, 0),
      totalCostUsd: sessionRecords.reduce((sum, record) => sum + record.estimatedCostUsd, 0),
      callCount: sessionRecords.length,
    };
  }

  // 获取最贵的操作 Top N
  getTopCostlyOperations(topN: number): TokenRecord[] {
    return [...this.records]
      .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd)
      .slice(0, topN);
  }

  // 获取全局统计
  getGlobalSummary(): { totalCostUsd: number; totalTokens: number; callCount: number } {
    return {
      totalCostUsd: this.records.reduce((sum, record) => sum + record.estimatedCostUsd, 0),
      totalTokens: this.records.reduce(
        (sum, record) => sum + record.promptTokens + record.completionTokens,
        0,
      ),
      callCount: this.records.length,
    };
  }
}
```

---

## 第三步：Token Budget — 设定预算上限

在 Agent 执行前设定 Token 预算，超出时拒绝继续执行：

```typescript
import { generateText, type LanguageModelUsage } from 'ai';
import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import { agentTools } from './tools.js';
import type { ChatContext } from './context-manager.js';
import { ContextManager } from './context-manager.js';

interface TokenBudget {
  maxTokensPerSession: number;   // 单次会话最多消耗多少 Token
  maxTokensPerRequest: number;   // 单次 LLM 调用最多消耗多少 Token
  warningThresholdRatio: number; // 达到预算的多少比例时发出警告（0~1）
}

const DEFAULT_BUDGET: TokenBudget = {
  maxTokensPerSession: 50_000,
  maxTokensPerRequest: 10_000,
  warningThresholdRatio: 0.8,
};

export class BudgetAwareAgent {
  private model: ReturnType<OpenAIProvider['chat']>;
  private tracker: TokenTracker;
  private budget: TokenBudget;

  constructor(
    model: ReturnType<OpenAIProvider['chat']>,
    modelName: string,
    budget: Partial<TokenBudget> = {},
  ) {
    this.model = model;
    this.tracker = new TokenTracker(modelName);
    this.budget = { ...DEFAULT_BUDGET, ...budget };
  }

  async chat(message: string, context: ChatContext, systemPrompt: string): Promise<string> {
    // 执行前检查：当前会话是否已超出预算
    const sessionSummary = this.tracker.getSessionSummary(context.sessionId);
    if (sessionSummary.totalPromptTokens + sessionSummary.totalCompletionTokens >= this.budget.maxTokensPerSession) {
      throw new Error(
        `会话 Token 预算已耗尽（已用 ${sessionSummary.totalPromptTokens + sessionSummary.totalCompletionTokens} / 上限 ${this.budget.maxTokensPerSession}）`,
      );
    }

    // 预算警告
    const usageRatio =
      (sessionSummary.totalPromptTokens + sessionSummary.totalCompletionTokens) /
      this.budget.maxTokensPerSession;
    if (usageRatio >= this.budget.warningThresholdRatio) {
      console.warn(
        `⚠️ Token 预算警告：已使用 ${(usageRatio * 100).toFixed(1)}%，请注意控制对话长度`,
      );
    }

    const messages = await ContextManager.buildMessages(systemPrompt, context, this.model);

    const { text, usage } = await generateText({
      model: this.model,
      messages,
      tools: agentTools,
      maxSteps: 5,
    });

    // 记录本次消耗
    this.tracker.record(context.sessionId, 'chat', usage);

    // 单次请求超出限制时记录警告（已经执行完，只能事后告警）
    const requestTokens = usage.promptTokens + usage.completionTokens;
    if (requestTokens > this.budget.maxTokensPerRequest) {
      console.warn(
        `⚠️ 单次请求 Token 超限：${requestTokens} > ${this.budget.maxTokensPerRequest}，考虑压缩上下文`,
      );
    }

    return text;
  }

  getBudgetStatus(sessionId: string): {
    used: number;
    limit: number;
    remaining: number;
    usagePercent: string;
  } {
    const summary = this.tracker.getSessionSummary(sessionId);
    const used = summary.totalPromptTokens + summary.totalCompletionTokens;
    return {
      used,
      limit: this.budget.maxTokensPerSession,
      remaining: Math.max(0, this.budget.maxTokensPerSession - used),
      usagePercent: `${((used / this.budget.maxTokensPerSession) * 100).toFixed(1)}%`,
    };
  }
}
```

---

## 第四步：Token 优化策略

追踪到消耗后，针对性优化：

### 策略一：压缩 System Prompt

System Prompt 每次都会带上，是最稳定的优化点：

```typescript
// ❌ 冗余的 System Prompt（约 200 tokens）
const verbosePrompt = `
你是一个非常专业的、经验丰富的、拥有多年工作经验的 AI 代码助手。
你的工作是帮助用户解决各种各样的编程问题，包括但不限于代码调试、
代码审查、架构设计、性能优化等各种技术问题。你应该尽量给出详细的、
完整的、可以直接运行的代码示例，并且要解释清楚每一步的原理...
`;

// ✅ 精简的 System Prompt（约 30 tokens）
const concisePrompt = `你是代码助手。给出简洁、可运行的代码，必要时解释原理。`;
```

### 策略二：按需激活工具

不要把所有工具都挂上，只挂当前任务需要的：

```typescript
// ❌ 每次都挂全部工具（工具描述本身也消耗 Token）
const allTools = { readFile, writeFile, listDir, runCommand, searchWeb, ... };

// ✅ 根据任务类型只挂相关工具
function selectTools(taskType: 'read' | 'write' | 'search') {
  const toolMap = {
    read:   { readFile, listDir },
    write:  { readFile, writeFile },
    search: { searchWeb },
  };
  return toolMap[taskType];
}
```

### 策略三：结合第8课的上下文压缩

Token 消耗随对话轮数线性增长，上下文压缩是最直接的降本手段（详见第8课）。

---

## 知识点总结

| 概念 | 说明 |
|------|------|
| **promptTokens** | 输入给模型的 Token 数，包含 system、历史消息、工具描述 |
| **completionTokens** | 模型生成的 Token 数，通常比输入贵 |
| **Token Budget** | 预设的 Token 消耗上限，超出时拒绝执行或发出警告 |
| **TokenTracker** | 按会话、操作维度聚合 Token 消耗的追踪器 |
| **按需激活工具** | 只挂当前任务需要的工具，减少工具描述占用的 Token |

---

## 与其他课程的关联

- **第8课（上下文管理）**：上下文压缩是最直接的 Token 降本手段，两课配合使用效果最佳
- **第13课（Skills 系统）**：Skills 的渐进式披露本质上也是一种 Token 优化——只在需要时才把 Skill 的工具描述注入上下文
